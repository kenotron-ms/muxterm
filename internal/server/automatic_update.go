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
const automaticAdmissionLifetime = 3 * time.Minute

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
	var admissionToken int64
	defer func() {
		if admissionToken != 0 {
			s.endAutomaticAdmission(admissionToken)
		}
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
		token, reason := s.beginAutomaticAdmission()
		if reason != "" {
			return errors.New(reason)
		}
		admissionToken = token
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
	s.sdkChats.markUpdateRecovery()
	s.recordAutomaticUpdate("restarting", "Verified update installed; restarting Muxterm.", status.LatestVersion, false, false)
	if err := update.Restart(update.RestoreCapability{OK: true, Reason: "running daemon verified restore and idle panes"}); err != nil {
		s.sdkChats.clearUpdateRecovery()
		applied = false
		s.recordAutomaticUpdate("error", "Update installed but restart failed: "+err.Error(), status.LatestVersion, false, false)
		log.Printf("automatic update: restart: %v", err)
	} else {
		releaseGate = false
		admissionToken = 0
	}
}

func (s *Server) activeUpdateWork() string {
	h := s.sdkChats
	h.mu.Lock()
	for _, item := range h.workItems {
		if item.Status == "active" || item.Status == "review" {
			h.mu.Unlock()
			return "Work is active; automatic update deferred."
		}
		if item.Dispatch != nil && (item.Dispatch.State == "preparing" || item.Dispatch.State == "sent" || item.Dispatch.State == "claimed") && item.Status != "done" && item.Status != "cancelled" {
			h.mu.Unlock()
			return "Work dispatch is in progress; automatic update deferred."
		}
	}
	for _, chat := range h.chats {
		if chat.State == "starting" || chat.State == "working" || chat.State == "uncertain" {
			h.mu.Unlock()
			return "A chat turn is active or uncertain; automatic update deferred."
		}
	}
	nodeRunning, amplifier := h.running, h.ampSup
	h.mu.Unlock()
	checkCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if nodeRunning {
		busy, err := h.sharedBusy(checkCtx)
		if err != nil {
			return "Could not confirm that shared chat turns are idle: " + err.Error()
		}
		if len(busy) > 0 {
			return "A shared chat turn is active; automatic update deferred."
		}
	}
	if amplifier != nil {
		command, _ := json.Marshal(map[string]string{"op": "runtime-busy"})
		response, err := amplifier.SDKCommand(checkCtx, command)
		if err != nil {
			return "Could not confirm that Amplifier chats are idle: " + err.Error()
		}
		var busy struct {
			SessionIDs []string `json:"sessionIds"`
		}
		if err := json.Unmarshal(response, &busy); err != nil {
			return "Could not read Amplifier chat activity: " + err.Error()
		}
		if len(busy.SessionIDs) > 0 {
			return "An Amplifier chat turn is active; automatic update deferred."
		}
	}
	return ""
}

// Locking admission waits for any accepted SDK command to finish. Work writes
// then either complete before the activity scan or fail while the gate is set.
// The deadline makes a crashed updater fail open for new chat actions only
// after the matching sessiond gate expires; it never authorizes an update.
func (s *Server) beginAutomaticAdmission() (int64, string) {
	h := s.sdkChats
	h.updateAdmission.Lock()
	if h.updateUntil.Load() > time.Now().UnixNano() {
		h.updateAdmission.Unlock()
		return 0, "Another automatic update is preparing."
	}
	token := time.Now().Add(automaticAdmissionLifetime).UnixNano()
	h.updateUntil.Store(token)
	h.updateAdmission.Unlock()
	if reason := s.activeUpdateWork(); reason != "" {
		h.updateUntil.CompareAndSwap(token, 0)
		return 0, reason
	}
	return token, ""
}

func (s *Server) endAutomaticAdmission(token int64) {
	s.sdkChats.updateUntil.CompareAndSwap(token, 0)
}

// The signed Mac companion calls this just before asking its native updater
// to restart. The gate expires automatically if the companion crashes.
func (s *Server) handleUpdatePrepare(w http.ResponseWriter, r *http.Request) {
	token, reason := s.beginAutomaticAdmission()
	if reason != "" {
		writeUpdateJSON(w, http.StatusOK, map[string]any{"safe": false, "reason": reason})
		return
	}
	keepAdmission := false
	defer func() {
		if !keepAdmission {
			s.endAutomaticAdmission(token)
		}
	}()
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
	keepGate := false
	defer func() {
		if !keepGate {
			if err := daemon.ReleaseUpdate(); err != nil {
				log.Printf("automatic update: release prepared Mac terminal gate: %v", err)
			}
		}
	}()
	if err := r.Context().Err(); err != nil {
		writeUpdateJSON(w, http.StatusOK, map[string]any{"safe": false, "reason": "Mac companion disconnected before terminal safety check."})
		return
	}
	ok, reason, err := daemon.PrepareUpdate()
	if err != nil {
		ok, reason = false, err.Error()
	}
	if ok {
		if work := s.activeUpdateWork(); work != "" {
			ok, reason = false, work
		} else if r.Context().Err() != nil {
			ok, reason = false, "Mac companion disconnected before update could proceed."
		} else {
			keepAdmission = true
			keepGate = true
		}
	}
	if !ok {
		writeUpdateJSON(w, http.StatusOK, map[string]any{"safe": false, "reason": reason})
		return
	}
	writeUpdateJSON(w, http.StatusOK, map[string]any{"safe": true, "token": token})
}

// A native companion may abandon a prepared restart after the daemon has
// entered its temporary update gate. Only that preparation's token releases it.
func (s *Server) handleUpdateRelease(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Token int64 `json:"token"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&request); err != nil || request.Token <= 0 {
		http.Error(w, "invalid update token", http.StatusBadRequest)
		return
	}
	h := s.sdkChats
	h.updateAdmission.Lock()
	if h.updateUntil.Load() != request.Token {
		h.updateAdmission.Unlock()
		http.Error(w, "update preparation is no longer active", http.StatusConflict)
		return
	}
	// Keep new preparations and chat calls gated while the daemon gate is
	// being released, without holding the admission lock across socket I/O.
	releaseToken := time.Now().Add(automaticAdmissionLifetime).UnixNano()
	h.updateUntil.Store(releaseToken)
	h.updateAdmission.Unlock()
	defer h.updateUntil.CompareAndSwap(releaseToken, 0)
	socket, err := sessiond.SocketPath()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	daemon, err := sessiond.Dial(socket)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer daemon.Close()
	go func() { _ = daemon.Run() }()
	if err := daemon.ReleaseUpdate(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
