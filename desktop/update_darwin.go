//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"
)

const macBundleID = "io.ampbox.muxterm.desktop"

type macUpdateEvent struct {
	Phase          string `json:"phase"`
	CurrentVersion string `json:"currentVersion,omitempty"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	Error          string `json:"error,omitempty"`
}

func (c *Companion) initMacUpdater() error {
	provider, err := github.New(github.Config{
		Repository:    "kenotron-ms/muxterm",
		ChecksumAsset: "macos-checksums.txt",
		AssetMatcher: func(_ updater.CheckRequest, assets []github.ReleaseAsset) int {
			for i, asset := range assets {
				if strings.HasPrefix(asset.Name, "Muxterm-") && strings.HasSuffix(asset.Name, "-macos-arm64.zip") {
					return i
				}
			}
			return -1
		},
	})
	if err != nil {
		return err
	}
	return c.app.Updater.Init(updater.Config{
		CurrentVersion: desktopBundleVersion(),
		Providers:      []updater.Provider{provider},
		Window:         updater.WindowNone,
	})
}

func (c *Companion) emitMacUpdate(event macUpdateEvent) {
	encoded, _ := json.Marshal(event)
	c.evalMuxtermJS("window.dispatchEvent(new CustomEvent('muxterm-mac-update', {detail:" + string(encoded) + "}))")
}

func (c *Companion) runMacUpdate(action string) {
	if !c.updateMu.TryLock() {
		c.emitMacUpdate(macUpdateEvent{Phase: "error", Error: "A Mac update is already in progress."})
		return
	}
	defer c.updateMu.Unlock()

	current := desktopBundleVersion()
	base := macUpdateEvent{CurrentVersion: current}
	if current == "dev" {
		base.Phase, base.Error = "error", "This development build cannot update itself."
		c.emitMacUpdate(base)
		return
	}
	installed, err := os.Executable()
	if err != nil {
		base.Phase, base.Error = "error", err.Error()
		c.emitMacUpdate(base)
		return
	}
	installed = filepath.Clean(installed)
	for !strings.HasSuffix(installed, ".app") && installed != filepath.Dir(installed) {
		installed = filepath.Dir(installed)
	}
	if !strings.HasSuffix(installed, ".app") {
		base.Phase, base.Error = "error", "Run Muxterm from an installed Mac app to update it."
		c.emitMacUpdate(base)
		return
	}
	team, err := signingTeam(installed)
	if err != nil || team == "" || team == "not set" {
		base.Phase, base.Error = "error", "This app is not signed for in-app updates."
		c.emitMacUpdate(base)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	base.Phase = "checking"
	c.emitMacUpdate(base)
	release, err := c.app.Updater.Check(ctx)
	if err != nil {
		base.Phase, base.Error = "error", fmt.Sprintf("Could not check Mac releases: %v", err)
		c.emitMacUpdate(base)
		return
	}
	if release == nil {
		base.Phase = "up-to-date"
		c.emitMacUpdate(base)
		return
	}
	if release.Verification == nil || release.Verification.DigestAlgo != "sha256" || len(release.Verification.Digest) != 32 {
		base.Phase, base.Error = "error", "The Mac release has no SHA-256 checksum."
		c.emitMacUpdate(base)
		return
	}
	base.LatestVersion = release.Version
	if action == "mac-update-check" {
		base.Phase = "available"
		c.emitMacUpdate(base)
		return
	}
	base.Phase = "downloading"
	c.emitMacUpdate(base)
	if err := c.app.Updater.DownloadAndInstall(ctx); err != nil {
		base.Phase, base.Error = "error", fmt.Sprintf("Could not download Mac update: %v", err)
		c.emitMacUpdate(base)
		return
	}
	base.Phase = "verifying"
	c.emitMacUpdate(base)
	if err := verifyMacUpdate(c.app.Updater.DownloadedPath(), release.Version, team); err != nil {
		base.Phase, base.Error = "error", fmt.Sprintf("Mac update verification failed: %v", err)
		c.emitMacUpdate(base)
		return
	}
	base.Phase = "restarting"
	c.emitMacUpdate(base)
	if err := c.app.Updater.Restart(ctx); err != nil {
		base.Phase, base.Error = "error", fmt.Sprintf("Could not restart into Mac update: %v", err)
		c.emitMacUpdate(base)
	}
}

func verifyMacUpdate(path, version, team string) error {
	if filepath.Base(path) != "Muxterm.app" {
		return errors.New("release does not contain Muxterm.app")
	}
	if err := exec.Command("codesign", "--verify", "--deep", "--strict", path).Run(); err != nil {
		return fmt.Errorf("code signature: %w", err)
	}
	if err := exec.Command("spctl", "--assess", "--type", "execute", path).Run(); err != nil {
		return fmt.Errorf("Gatekeeper assessment: %w", err)
	}
	actualTeam, err := signingTeam(path)
	if err != nil || actualTeam != team {
		return errors.New("release signing team differs from the installed app")
	}
	for key, want := range map[string]string{"CFBundleIdentifier": macBundleID, "CFBundleShortVersionString": version} {
		value, err := exec.Command("plutil", "-extract", key, "raw", "-o", "-", filepath.Join(path, "Contents", "Info.plist")).Output()
		if err != nil || strings.TrimSpace(string(value)) != want {
			return fmt.Errorf("release has unexpected %s", key)
		}
	}
	return nil
}

func signingTeam(path string) (string, error) {
	output, err := exec.Command("codesign", "--display", "--verbose=4", path).CombinedOutput()
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(output), "\n") {
		if team, ok := strings.CutPrefix(line, "TeamIdentifier="); ok {
			return strings.TrimSpace(team), nil
		}
	}
	return "", errors.New("missing signing team")
}
