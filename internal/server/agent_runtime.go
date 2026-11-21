package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"
)

var managedChatHarnesses = []string{
	"codex", "claude", "copilot", "amplifier", "pi", "opencode", "deepseek",
	"gemini", "antigravity", "antigravity-sdk", "amplifier-unified",
}

func managedChatHarness(harness string) bool {
	for _, name := range managedChatHarnesses {
		if name == harness {
			return true
		}
	}
	return false
}

// The executable identity is checked before every chat start or resume. It
// catches a new user-level install and an in-place update without asking the
// browser or a terminal command to report whether an installer succeeded.
func sdkRuntimeFingerprint(harness string) string {
	path := sdkRuntimeExecutablePath(harness)
	if path == "" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	fileID := uint64(0)
	if value := reflect.ValueOf(info.Sys()); value.IsValid() && value.Kind() == reflect.Pointer {
		if inode := value.Elem().FieldByName("Ino"); inode.IsValid() && inode.CanUint() {
			fileID = inode.Uint()
		}
	}
	return fmt.Sprintf("%s:%d:%d:%d", path, info.Size(), info.ModTime().UnixNano(), fileID)
}

func sdkRuntimeExecutablePath(harness string) string {
	command := ""
	switch harness {
	case "codex", "claude":
		command, _ = sdkAgentExecutable(harness)
	case "copilot", "pi", "deepseek", "gemini":
		command = map[string]string{"copilot": "copilot", "pi": "pi", "deepseek": "dsh", "gemini": "gemini"}[harness]
	case "opencode":
		command = os.Getenv("MUXTERM_ACP_OPENCODE_COMMAND")
		if command == "" {
			home, _ := os.UserHomeDir()
			candidate := filepath.Join(home, ".opencode", "bin", "opencode")
			if _, err := os.Stat(candidate); err == nil {
				command = candidate
			} else {
				command = "opencode"
			}
		}
	case "antigravity":
		command = sdkACPExecutable(harness)
	case "antigravity-sdk":
		command = "uv"
	case "amplifier":
		command = "amplifier"
	default:
		return ""
	}
	path, err := sdkExecutablePath(command)
	if err != nil {
		return ""
	}
	return path
}

func sdkRuntimeFingerprints() map[string]string {
	versions := make(map[string]string, len(managedChatHarnesses))
	for _, harness := range managedChatHarnesses {
		versions[harness] = sdkRuntimeFingerprint(harness)
	}
	return versions
}

// A terminal installer has no browser-owned completion signal. Watching the
// executable identity lets a successful install refresh an already-running
// sidecar without asking the user to scan or begin another chat. Two matching
// observations keep an in-progress replacement from being launched halfway
// through a write.
func (h *sdkChatHost) watchAgentInstalls(ctx context.Context) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	last := sdkRuntimeFingerprints()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		current := sdkRuntimeFingerprints()
		for _, harness := range managedChatHarnesses {
			if current[harness] == "" || current[harness] != last[harness] {
				continue
			}
			h.runtimeGate.Lock()
			h.lifecycleMu.Lock()
			h.mu.Lock()
			running := h.running && !h.manualStopped
			stale := h.sidecarVersions[harness] != current[harness]
			amplifier := harness == "amplifier"
			if amplifier {
				running = h.ampSup != nil && !h.ampStopped
				stale = h.ampVersion != current[harness]
			}
			h.mu.Unlock()
			if running && stale && len(h.activeRuntimeChats(amplifier)) == 0 {
				if amplifier {
					_ = h.ensureRuntimeLocked(harness)
				} else {
					checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
					busy, err := h.sharedBusy(checkCtx)
					cancel()
					if err == nil && len(busy) == 0 {
						_ = h.ensureRuntimeLocked(harness)
					}
				}
			}
			h.lifecycleMu.Unlock()
			h.runtimeGate.Unlock()
		}
		last = current
	}
}

func (h *sdkChatHost) activeRuntimeChats(amplifier bool) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var active []string
	for _, chat := range h.chats {
		if (chat.Harness == "amplifier") == amplifier && (chat.State == "working" || chat.State == "starting") {
			active = append(active, chat.ID)
		}
	}
	sort.Strings(active)
	return active
}

func (h *sdkChatHost) setRuntimeStopped(amplifier, stopped bool) {
	h.mu.Lock()
	if amplifier {
		h.ampStopped = stopped
	} else {
		h.manualStopped = stopped
	}
	h.mu.Unlock()
}

func (h *sdkChatHost) stopNode() error {
	h.mu.Lock()
	cmd, done := h.process, h.done
	h.mu.Unlock()
	if cmd == nil || cmd.Process == nil || done == nil {
		return nil
	}
	if err := cmd.Process.Signal(os.Interrupt); err != nil {
		select {
		case <-done:
			return nil
		default:
			return err
		}
	}
	select {
	case <-done:
		return nil
	case <-time.After(15 * time.Second):
		_ = cmd.Process.Kill()
		<-done
		return errors.New("shared chat runtime did not stop gracefully")
	}
}

func (h *sdkChatHost) sharedBusy(ctx context.Context) ([]string, error) {
	result, err := h.callNode(ctx, "runtime-busy", map[string]any{})
	if err != nil {
		return nil, err
	}
	var busy struct {
		SessionIDs []string `json:"sessionIds"`
	}
	if err := json.Unmarshal(result, &busy); err != nil {
		return nil, err
	}
	return busy.SessionIDs, nil
}

type agentRuntimeStatus struct {
	Harness     string `json:"harness"`
	Scope       string `json:"scope"`
	State       string `json:"state"`
	ActiveChats int    `json:"activeChats"`
}

func (h *sdkChatHost) runtimeStatus(harness string) agentRuntimeStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	status := agentRuntimeStatus{Harness: harness, Scope: "shared", State: "not-started"}
	if harness == "amplifier" {
		status.Scope = "amplifier"
		if h.ampStopped {
			status.State = "stopped"
		} else if h.ampSup != nil && h.ampSup.Running() {
			status.State = "running"
		}
	} else if h.manualStopped {
		status.State = "stopped"
	} else if h.running {
		status.State = "running"
	}
	for _, chat := range h.chats {
		if (chat.Harness == "amplifier") == (harness == "amplifier") && (chat.State == "working" || chat.State == "starting") {
			status.ActiveChats++
		}
	}
	return status
}

func (s *Server) handleAgentRuntimes(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	statuses := make([]agentRuntimeStatus, 0, len(managedChatHarnesses))
	for _, harness := range managedChatHarnesses {
		statuses = append(statuses, s.sdkChats.runtimeStatus(harness))
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{"agents": statuses})
}

func (s *Server) handleAgentRuntimeAction(w http.ResponseWriter, r *http.Request) {
	harness, action := r.PathValue("harness"), r.PathValue("action")
	if !managedChatHarness(harness) || (action != "stop" && action != "restart") {
		http.Error(w, "unsupported agent runtime action", http.StatusBadRequest)
		return
	}
	h := s.sdkChats
	h.runtimeGate.Lock()
	defer h.runtimeGate.Unlock()
	h.lifecycleMu.Lock()
	defer h.lifecycleMu.Unlock()
	amplifier := harness == "amplifier"
	if active := h.activeRuntimeChats(amplifier); len(active) > 0 {
		verb := "stopping"
		if action == "restart" {
			verb = "restarting"
		}
		http.Error(w, fmt.Sprintf("Finish the active %s chat turns before %s this runtime: %s", map[bool]string{true: "Amplifier", false: "shared"}[amplifier], verb, strings.Join(active, ", ")), http.StatusConflict)
		return
	}
	if !amplifier {
		h.mu.Lock()
		running := h.running
		h.mu.Unlock()
		if running {
			ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
			busy, err := h.sharedBusy(ctx)
			cancel()
			if err != nil {
				http.Error(w, "Could not confirm that shared chats are idle: "+err.Error(), http.StatusBadGateway)
				return
			}
			if len(busy) > 0 {
				http.Error(w, "Finish the active shared chat turns before changing this runtime: "+strings.Join(busy, ", "), http.StatusConflict)
				return
			}
		}
	}
	if amplifier {
		if action == "stop" {
			h.setRuntimeStopped(true, true)
			h.mu.Lock()
			sup := h.ampSup
			h.ampSup = nil
			h.mu.Unlock()
			if sup != nil {
				if err := sup.Close(); err != nil {
					http.Error(w, "Amplifier runtime could not stop: "+err.Error(), http.StatusBadGateway)
					return
				}
			}
		} else {
			h.setRuntimeStopped(true, false)
			h.mu.Lock()
			sup := h.ampSup
			h.ampSup = nil
			h.mu.Unlock()
			if sup != nil {
				_ = sup.Close()
			}
			if err := h.ensureAmplifier(); err != nil {
				h.setRuntimeStopped(true, true)
				http.Error(w, "Amplifier runtime could not restart: "+err.Error(), http.StatusBadGateway)
				return
			}
		}
	} else {
		h.setRuntimeStopped(false, action == "stop")
		if err := h.stopNode(); err != nil {
			http.Error(w, "shared chat runtime could not stop: "+err.Error(), http.StatusBadGateway)
			return
		}
		if action == "restart" {
			if err := h.ensureRuntimeLocked(harness); err != nil {
				h.setRuntimeStopped(false, true)
				http.Error(w, "shared chat runtime could not restart: "+err.Error(), http.StatusBadGateway)
				return
			}
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeSDKJSON(w, http.StatusOK, h.runtimeStatus(harness))
}
