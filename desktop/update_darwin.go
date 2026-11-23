//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"
)

const macBundleID = "io.ampbox.muxterm.desktop"

func (c *Companion) initMacUpdater() error {
	providerConfig := github.Config{
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
	}
	if fixture := os.Getenv("MUXTERM_MAC_UPDATE_FIXTURE_BASE_URL"); fixture != "" {
		parsed, err := url.Parse(fixture)
		if os.Getenv("GITHUB_ACTIONS") != "true" || err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.Port() == "" {
			return errors.New("Mac update fixture URL is restricted to a loopback GitHub Actions runner")
		}
		providerConfig.BaseURL = fixture
	}
	provider, err := github.New(providerConfig)
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
	c.recordMacAutomaticUpdate(event)
	encoded, _ := json.Marshal(event)
	c.evalMuxtermJS("window.dispatchEvent(new CustomEvent('muxterm-mac-update', {detail:" + string(encoded) + "}))")
}

func (c *Companion) runMacUpdate(parent context.Context, action string) {
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

	ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
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
	if action == "mac-update-auto" && !c.macAutomaticStatus().Enabled {
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
	if action == "mac-update-auto" && !c.macAutomaticStatus().Enabled {
		base.Phase, base.Error = "deferred", "Automatic updates were turned off."
		c.emitMacUpdate(base)
		return
	}
	if action == "mac-update-auto" {
		token, err := c.checkMacHostSafety(ctx)
		if err != nil {
			base.Phase, base.Error = "deferred", err.Error()
			c.emitMacUpdate(base)
			return
		}
		if !c.macAutomaticStatus().Enabled {
			_ = c.releaseMacHostSafety(token)
			return
		}
		base.Phase = "restarting"
		c.emitMacUpdate(base)
		if err := c.app.Updater.Restart(ctx); err != nil {
			base.Phase, base.Error = "error", fmt.Sprintf("Could not restart into Mac update: %v", err)
			if releaseErr := c.releaseMacHostSafety(token); releaseErr != nil {
				base.Error += "; could not release the temporary terminal gate: " + releaseErr.Error()
			}
			c.emitMacUpdate(base)
		}
		return
	}
	base.Phase = "restarting"
	c.emitMacUpdate(base)
	if err := c.app.Updater.Restart(ctx); err != nil {
		base.Phase, base.Error = "error", fmt.Sprintf("Could not restart into Mac update: %v", err)
		c.emitMacUpdate(base)
	}
}

func (c *Companion) macAutoEligible() (bool, string) {
	if !c.macUpdaterReady {
		return false, "The Mac app updater is unavailable."
	}
	if desktopBundleVersion() == "dev" {
		return false, "Development Mac apps cannot install automatic releases."
	}
	executable, err := os.Executable()
	if err != nil {
		return false, "Could not locate this Mac app."
	}
	path := filepath.Clean(executable)
	for !strings.HasSuffix(path, ".app") && path != filepath.Dir(path) {
		path = filepath.Dir(path)
	}
	if !strings.HasSuffix(path, ".app") {
		return false, "Run Muxterm from an installed Mac app to update it."
	}
	team, err := signingTeam(path)
	if err != nil || team == "" || team == "not set" {
		return false, "This Mac app is not signed for in-app updates."
	}
	return true, ""
}

func (c *Companion) runMacAutomaticUpdates() {
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-c.autoStop:
			return
		case <-c.autoWake:
		case <-timer.C:
		}
		view := c.macAutomaticStatus()
		if view.Eligible && view.Enabled && (view.LastCheck.IsZero() || time.Since(view.LastCheck) >= 6*time.Hour) {
			attemptCtx, cancel := context.WithCancel(context.Background())
			finished := make(chan struct{})
			go func() {
				select {
				case <-c.autoStop:
					cancel()
				case <-finished:
				}
			}()
			c.runMacUpdate(attemptCtx, "mac-update-auto")
			close(finished)
			cancel()
		}
		timer.Reset(time.Hour)
	}
}

func (c *Companion) checkMacHostSafety(ctx context.Context) (int64, error) {
	c.mu.Lock()
	local := c.local
	c.mu.Unlock()
	if local == nil {
		return 0, errors.New("The local Muxterm host is unavailable; update deferred.")
	}
	client := http.Client{Timeout: 5 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, local.url+"api/update/prepare", nil)
	if err != nil {
		return 0, err
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("Could not check local terminal safety: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("Local terminal safety check returned HTTP %d", response.StatusCode)
	}
	var result struct {
		Safe   bool   `json:"safe"`
		Reason string `json:"reason"`
		Token  int64  `json:"token"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return 0, fmt.Errorf("Could not read local terminal safety: %w", err)
	}
	if !result.Safe {
		return 0, errors.New(result.Reason)
	}
	if result.Token <= 0 {
		return 0, errors.New("Local terminal safety check did not return a release token")
	}
	return result.Token, nil
}

func (c *Companion) releaseMacHostSafety(token int64) error {
	c.mu.Lock()
	local := c.local
	c.mu.Unlock()
	if local == nil {
		return errors.New("the local Muxterm host is unavailable")
	}
	client := http.Client{Timeout: 5 * time.Second}
	body := strings.NewReader(fmt.Sprintf(`{"token":%d}`, token))
	response, err := client.Post(local.url+"api/update/release", "application/json", body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("local terminal gate release returned HTTP %d", response.StatusCode)
	}
	return nil
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
