package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

type macAutomaticRecord struct {
	Enabled       bool      `json:"enabled"`
	Phase         string    `json:"phase"`
	Message       string    `json:"message,omitempty"`
	LatestVersion string    `json:"latestVersion,omitempty"`
	LastCheck     time.Time `json:"lastCheck,omitzero"`
	LastUpdate    time.Time `json:"lastUpdate,omitzero"`
}

type macUpdateEvent struct {
	Phase          string `json:"phase"`
	CurrentVersion string `json:"currentVersion,omitempty"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	Error          string `json:"error,omitempty"`
}

type macAutomaticView struct {
	macAutomaticRecord
	Eligible bool   `json:"eligible"`
	Reason   string `json:"reason,omitempty"`
	Error    string `json:"error,omitempty"`
}

func macAutomaticPath() string {
	path := settingsPath()
	if path == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(path), "automatic-updates.json")
}

func (c *Companion) loadMacAutomaticUpdate() {
	c.autoRecord = macAutomaticRecord{Phase: "off"}
	data, err := os.ReadFile(macAutomaticPath())
	if err != nil {
		return
	}
	var saved macAutomaticRecord
	if json.Unmarshal(data, &saved) == nil {
		c.autoRecord = saved
		if !saved.Enabled {
			c.autoRecord.Phase = "off"
		}
		if saved.Phase == "restarting" {
			if desktopBundleVersion() == saved.LatestVersion {
				c.autoRecord.Phase, c.autoRecord.Message, c.autoRecord.LastUpdate = "current", "Updated to Mac app version "+saved.LatestVersion+".", time.Now().UTC()
			} else {
				c.autoRecord.Phase, c.autoRecord.Message = "error", "The Mac app restart did not reach version "+saved.LatestVersion+"."
			}
			_ = c.saveMacAutomaticLocked(c.autoRecord)
		}
		if c.autoRecord.Enabled {
			select {
			case c.autoWake <- struct{}{}:
			default:
			}
		}
	}
}

func (c *Companion) saveMacAutomaticLocked(next macAutomaticRecord) error {
	path := macAutomaticPath()
	if path == "" {
		return errors.New("Mac app settings path unavailable")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".automatic-updates-*")
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
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	c.autoRecord = next
	return nil
}

func (c *Companion) setMacAutomaticUpdates(enabled bool) error {
	eligible, reason := c.macAutoEligible()
	if enabled && !eligible {
		return errors.New(reason)
	}
	c.autoMu.Lock()
	defer c.autoMu.Unlock()
	next := c.autoRecord
	next.Enabled = enabled
	if enabled {
		next.Phase = "waiting"
		next.Message = "Automatic checks are on. The next check will run shortly."
		next.LastCheck = time.Time{}
	} else {
		next.Phase = "off"
		next.Message = "Automatic checks are off. Manual updates remain available."
	}
	if err := c.saveMacAutomaticLocked(next); err != nil {
		return err
	}
	if enabled {
		select {
		case c.autoWake <- struct{}{}:
		default:
		}
	}
	return nil
}

func (c *Companion) macAutomaticStatus() macAutomaticView {
	eligible, reason := c.macAutoEligible()
	c.autoMu.Lock()
	view := macAutomaticView{macAutomaticRecord: c.autoRecord, Eligible: eligible, Reason: reason}
	c.autoMu.Unlock()
	return view
}

func (c *Companion) emitMacAutomaticUpdateStatus() {
	encoded, _ := json.Marshal(c.macAutomaticStatus())
	c.evalMuxtermJS("window.dispatchEvent(new CustomEvent('muxterm-mac-auto-update', {detail:" + string(encoded) + "}))")
}

func (c *Companion) emitMacAutomaticUpdateError(reason string) {
	view := c.macAutomaticStatus()
	view.Error = reason
	encoded, _ := json.Marshal(view)
	c.evalMuxtermJS("window.dispatchEvent(new CustomEvent('muxterm-mac-auto-update', {detail:" + string(encoded) + "}))")
}

func (c *Companion) recordMacAutomaticUpdate(event macUpdateEvent) {
	c.autoMu.Lock()
	defer c.autoMu.Unlock()
	if !c.autoRecord.Enabled {
		return
	}
	next := c.autoRecord
	if event.LatestVersion != "" {
		next.LatestVersion = event.LatestVersion
	}
	switch event.Phase {
	case "checking", "downloading", "verifying", "restarting":
		next.Phase, next.Message = event.Phase, "Mac app update "+event.Phase+"."
	case "available":
		next.Phase, next.Message, next.LastCheck = "available", "A newer Mac app is available.", time.Now().UTC()
	case "up-to-date":
		next.Phase, next.Message, next.LastCheck = "current", "Mac app is up to date.", time.Now().UTC()
	case "error":
		next.Phase, next.Message, next.LastCheck = "error", event.Error, time.Now().UTC()
	case "deferred":
		next.Phase, next.Message, next.LastCheck = "deferred", event.Error, time.Now().UTC()
	}
	_ = c.saveMacAutomaticLocked(next)
}
