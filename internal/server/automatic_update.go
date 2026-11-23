package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
	"github.com/kenotron-ms/muxterm/internal/update"
)

const automaticCheckInterval = 6 * time.Hour

// The preference and the last outcome belong to the host, not to a browser.
// They survive both server restarts and a closed PWA. A malformed or missing
// file leaves the opt-in off; a failed write never changes the live setting.
type automaticUpdateRecord struct {
	Enabled       bool      `json:"enabled"`
	Phase         string    `json:"phase"`
	Message       string    `json:"message,omitempty"`
	LatestVersion string    `json:"latestVersion,omitempty"`
	LastCheck     time.Time `json:"lastCheck,omitzero"`
	LastUpdate    time.Time `json:"lastUpdate,omitzero"`
}

type automaticUpdateState struct {
	mu     sync.Mutex
	path   string
	record automaticUpdateRecord
	wake   chan struct{}
}

type automaticUpdateView struct {
	automaticUpdateRecord
	Eligible bool   `json:"eligible"`
	Reason   string `json:"reason,omitempty"`
}

func newAutomaticUpdateState(configPath string) *automaticUpdateState {
	state := &automaticUpdateState{record: automaticUpdateRecord{Phase: "off"}, wake: make(chan struct{}, 1)}
	if configPath == "" {
		return state
	}
	state.path = filepath.Join(filepath.Dir(configPath), "automatic-updates.json")
	data, err := os.ReadFile(state.path)
	if err == nil {
		var saved automaticUpdateRecord
		if json.Unmarshal(data, &saved) == nil {
			state.record = saved
			if !saved.Enabled {
				state.record.Phase = "off"
			}
		} else {
			log.Printf("automatic update: ignoring unreadable state at %s", state.path)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		log.Printf("automatic update: cannot read state: %v", err)
	}
	return state
}

func (s *Server) reconcileAutomaticUpdate() {
	s.autoUpdate.mu.Lock()
	defer s.autoUpdate.mu.Unlock()
	next := s.autoUpdate.record
	if next.Phase != "restarting" {
		return
	}
	if strings.TrimPrefix(s.version, "v") == strings.TrimPrefix(next.LatestVersion, "v") {
		next.Phase, next.Message, next.LastUpdate = "current", "Updated to version "+next.LatestVersion+".", time.Now().UTC()
	} else {
		next.Phase, next.Message = "error", "The update restart did not reach version "+next.LatestVersion+"."
	}
	if err := s.autoUpdate.saveLocked(next); err != nil {
		log.Printf("automatic update: reconcile status: %v", err)
	}
}

func (s *Server) automaticUpdateEligibility() (bool, string) {
	method, reason := update.Platform()
	switch {
	case s.noAuth || !s.releaseBuild || update.IsDev(s.version) || os.Getenv("MUXTERM_DEV_INSTANCE") == "1" || os.Getenv("CI") != "":
		return false, "Development builds cannot install automatic releases."
	case os.Getenv("MUXTERM_DISABLE_UPDATE_CHECK") == "1":
		return false, "Update checks are disabled on this host."
	case method != update.MethodBinary:
		return false, reason
	case s.autoUpdate.path == "":
		return false, "A persistent host config path is required."
	default:
		return true, ""
	}
}

func (s *Server) automaticUpdateView() automaticUpdateView {
	eligible, reason := s.automaticUpdateEligibility()
	s.autoUpdate.mu.Lock()
	view := automaticUpdateView{automaticUpdateRecord: s.autoUpdate.record, Eligible: eligible, Reason: reason}
	s.autoUpdate.mu.Unlock()
	return view
}

func (s *Server) handleAutomaticUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeUpdateJSON(w, http.StatusOK, s.automaticUpdateView())
		return
	}
	var request struct {
		Enabled *bool `json:"enabled"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || request.Enabled == nil || decoder.Decode(new(any)) != io.EOF {
		writeUpdateError(w, http.StatusBadRequest, "expected one enabled boolean")
		return
	}
	eligible, reason := s.automaticUpdateEligibility()
	if *request.Enabled && !eligible {
		writeUpdateError(w, http.StatusConflict, reason)
		return
	}
	s.autoUpdate.mu.Lock()
	next := s.autoUpdate.record
	next.Enabled = *request.Enabled
	if next.Enabled {
		next.Phase = "waiting"
		next.Message = "Automatic checks are on. The next check will run shortly."
		next.LastCheck = time.Time{}
	} else {
		next.Phase = "off"
		next.Message = "Automatic checks are off. Manual updates remain available."
	}
	if err := s.autoUpdate.saveLocked(next); err != nil {
		s.autoUpdate.mu.Unlock()
		writeUpdateError(w, http.StatusInternalServerError, "could not save automatic update setting: "+err.Error())
		return
	}
	s.autoUpdate.mu.Unlock()
	if *request.Enabled {
		select {
		case s.autoUpdate.wake <- struct{}{}:
		default:
		}
	}
	writeUpdateJSON(w, http.StatusOK, s.automaticUpdateView())
}

func (state *automaticUpdateState) saveLocked(next automaticUpdateRecord) error {
	if state.path == "" {
		return errors.New("persistent state path unavailable")
	}
	if err := os.MkdirAll(filepath.Dir(state.path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(state.path), ".automatic-updates-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := json.NewEncoder(tmp).Encode(next); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), state.path); err != nil {
		return err
	}
	state.record = next
	return nil
}

func (s *Server) recordAutomaticUpdate(phase, message, version string, checked, updated bool) {
	s.autoUpdate.mu.Lock()
	defer s.autoUpdate.mu.Unlock()
	if !s.autoUpdate.record.Enabled {
		return
	}
	next := s.autoUpdate.record
	next.Phase, next.Message = phase, message
	if version != "" {
		next.LatestVersion = version
	}
	if checked {
		next.LastCheck = time.Now().UTC()
	}
	if updated {
		next.LastUpdate = time.Now().UTC()
	}
	if err := s.autoUpdate.saveLocked(next); err != nil {
		log.Printf("automatic update: save status: %v", err)
	}
}

func (s *Server) runAutomaticUpdates(ctx context.Context) {
	// The first tick follows server startup, including when no browser opens.
	// A short delay lets sessiond and the local auth handoff finish booting.
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.autoUpdate.wake:
		case <-timer.C:
		}
		view := s.automaticUpdateView()
		if view.Eligible && view.Enabled && (view.LastCheck.IsZero() || time.Since(view.LastCheck) >= automaticCheckInterval) {
			s.automaticUpdateAttempt(ctx)
		}
		timer.Reset(time.Hour)
	}
}

func (s *Server) automaticUpdateAttempt(ctx context.Context) {
	if !s.updating.CompareAndSwap(false, true) {
		return
	}
	applied := false
	defer func() {
		if !applied {
			s.updating.Store(false)
		}
	}()
	checkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	s.recordAutomaticUpdate("checking", "Checking for a published release.", "", false, false)
	status, release := s.checkUpdate(checkCtx, false)
	if status.Error != "" {
		s.recordAutomaticUpdate("error", "Could not check releases: "+status.Error, "", true, false)
		return
	}
	if !status.UpdateAvailable {
		s.recordAutomaticUpdate("current", "Muxterm is up to date.", status.LatestVersion, true, false)
		return
	}
	if !status.CanUpdate || release == nil {
		s.recordAutomaticUpdate("deferred", "This release cannot update this host: "+strings.TrimSpace(status.Reason), status.LatestVersion, true, false)
		return
	}
	s.recordAutomaticUpdate("available", fmt.Sprintf("Version %s is available; checking for a safe window.", status.LatestVersion), status.LatestVersion, true, false)
	applyCtx, stopApply := context.WithTimeout(ctx, 12*time.Minute)
	defer stopApply()
	var daemon *sessiond.Client
	var safetyError error
	releaseGate := true
	defer func() {
		if daemon != nil {
			if releaseGate {
				_ = daemon.ReleaseUpdate()
			}
			_ = daemon.Close()
		}
	}()
	err := update.ApplyWithPreInstall(applyCtx, release, func() (guardErr error) {
		defer func() { safetyError = guardErr }()
		if !s.automaticUpdateView().Enabled {
			return errors.New("automatic updates were turned off")
		}
		if reason := s.activeUpdateWork(); reason != "" {
			return errors.New(reason)
		}
		socket, err := sessiond.SocketPath()
		if err != nil {
			return fmt.Errorf("cannot locate terminal daemon: %w", err)
		}
		daemon, err = sessiond.Dial(socket)
		if err != nil {
			return fmt.Errorf("cannot contact terminal daemon: %w", err)
		}
		go func() { _ = daemon.Run() }()
		ok, reason, err := daemon.PrepareUpdate()
		if err != nil {
			return fmt.Errorf("terminal daemon safety check failed: %w", err)
		}
		if !ok {
			return errors.New(reason)
		}
		if !s.automaticUpdateView().Enabled {
			return errors.New("automatic updates were turned off")
		}
		if reason := s.activeUpdateWork(); reason != "" {
			return errors.New(reason)
		}
		return nil
	})
	if err != nil {
		phase := "error"
		if safetyError != nil {
			phase = "deferred"
		}
		s.recordAutomaticUpdate(phase, err.Error(), status.LatestVersion, false, false)
		return
	}
	applied = true
	s.recordAutomaticUpdate("restarting", "Verified update installed; restarting Muxterm.", status.LatestVersion, false, false)
	if err := update.Restart(update.RestoreCapability{OK: true, Reason: "running daemon verified restore and idle panes"}); err != nil {
		s.recordAutomaticUpdate("error", "Update installed but restart failed: "+err.Error(), status.LatestVersion, false, false)
		log.Printf("automatic update: restart: %v", err)
	} else {
		releaseGate = false
	}
}

func (s *Server) activeUpdateWork() string {
	h := s.sdkChats
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, item := range h.workItems {
		if item.Status == "active" || item.Status == "review" {
			return "Work is active; automatic update deferred."
		}
	}
	for _, chat := range h.chats {
		if chat.State == "starting" || chat.State == "working" || chat.State == "uncertain" {
			return "A chat turn is active or uncertain; automatic update deferred."
		}
	}
	return ""
}

// The signed Mac companion calls this just before asking its native updater
// to restart. The gate expires automatically if the companion crashes.
func (s *Server) handleUpdatePrepare(w http.ResponseWriter, r *http.Request) {
	if reason := s.activeUpdateWork(); reason != "" {
		writeUpdateJSON(w, http.StatusOK, map[string]any{"safe": false, "reason": reason})
		return
	}
	socket, err := sessiond.SocketPath()
	if err != nil {
		writeUpdateJSON(w, http.StatusOK, map[string]any{"safe": false, "reason": err.Error()})
		return
	}
	daemon, err := sessiond.Dial(socket)
	if err != nil {
		writeUpdateJSON(w, http.StatusOK, map[string]any{"safe": false, "reason": err.Error()})
		return
	}
	defer daemon.Close()
	go func() { _ = daemon.Run() }()
	ok, reason, err := daemon.PrepareUpdate()
	if err != nil {
		ok, reason = false, err.Error()
	}
	if ok {
		if work := s.activeUpdateWork(); work != "" {
			ok, reason = false, work
			_ = daemon.ReleaseUpdate()
		}
	}
	writeUpdateJSON(w, http.StatusOK, map[string]any{"safe": ok, "reason": reason})
}
