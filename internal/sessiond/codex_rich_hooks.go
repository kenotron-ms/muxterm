package sessiond

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const CodexHookBridgeEnv = "MUXTERM_CODEX_BRIDGE"
const CodexRichReportingEnv = "MUXTERM_CODEX_RICH_REPORTING"

var codexRichEvents = []string{
	"SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse",
	"PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Stop", "Interrupt",
}

const codexRichHookCommand = `exec "${MUXTERM_CODEX_BRIDGE:?}" session codex-hook`

type codexRPCResponse struct {
	ID     int `json:"id"`
	Result struct {
		Data []struct {
			Hooks []struct {
				Key         string `json:"key"`
				EventName   string `json:"eventName"`
				Source      string `json:"source"`
				CurrentHash string `json:"currentHash"`
				TrustStatus string `json:"trustStatus"`
			} `json:"hooks"`
			Warnings []string `json:"warnings"`
			Errors   []string `json:"errors"`
		} `json:"data"`
	} `json:"result"`
	Error any `json:"error"`
}

// CodexRichHookArgs builds an invocation-only hook layer, asks this exact
// Codex binary to hash it, then supplies matching trust state. It never writes
// hooks.json or config.toml and never uses the dangerous trust-bypass switch.
func CodexRichHookArgs(codex, cwd string) ([]string, error) {
	definition := make([]string, 0, len(codexRichEvents)*2)
	for _, event := range codexRichEvents {
		value := `[{hooks=[{type="command",command=` + strconv.Quote(codexRichHookCommand) + `,timeout=3,statusMessage="Reporting to muxterm"}]}]`
		definition = append(definition, "-c", "hooks."+event+"="+value)
	}
	hooks, err := codexHookInventory(codex, cwd, definition)
	if err != nil {
		return nil, fmt.Errorf("verify Codex hook configuration: %w", err)
	}
	if len(hooks) != len(codexRichEvents) {
		return nil, fmt.Errorf("Codex exposed %d of %d muxterm hooks", len(hooks), len(codexRichEvents))
	}
	states := make([]string, 0, len(hooks))
	for _, hook := range hooks {
		if hook.Source != "sessionFlags" || hook.Key == "" || hook.CurrentHash == "" {
			return nil, fmt.Errorf("Codex returned an unverifiable hook source for %s", hook.EventName)
		}
		states = append(states, strconv.Quote(hook.Key)+"={enabled=true,trusted_hash="+strconv.Quote(hook.CurrentHash)+"}")
	}
	trusted := append(append([]string{}, definition...), "-c", "hooks.state={"+strings.Join(states, ",")+"}")
	verified, err := codexHookInventory(codex, cwd, trusted)
	if err != nil {
		return nil, fmt.Errorf("confirm Codex hook trust: %w", err)
	}
	for _, hook := range verified {
		if hook.TrustStatus != "trusted" {
			return nil, fmt.Errorf("Codex hook %s is %s, not trusted", hook.EventName, hook.TrustStatus)
		}
	}
	return append(trusted, "-c", "tools.update_plan.enabled=true"), nil
}

func codexHookInventory(codex, cwd string, overrides []string) ([]struct {
	Key, EventName, Source, CurrentHash, TrustStatus string
}, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	args := append([]string{"app-server", "--stdio"}, overrides...)
	cmd := exec.CommandContext(ctx, codex, args...)
	cmd.Dir = cwd
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	requests := []string{
		`{"id":1,"method":"initialize","params":{"clientInfo":{"name":"muxterm","version":"1"},"capabilities":{"experimentalApi":true}}}`,
		`{"id":2,"method":"hooks/list","params":{"cwds":[]}}`,
	}
	// The cwd is encoded separately to avoid shell quoting; this is JSON, not a command.
	request2, _ := json.Marshal(map[string]any{"id": 2, "method": "hooks/list", "params": map[string]any{"cwds": []string{cwd}}})
	requests[1] = string(request2)
	for _, request := range requests {
		if _, err := io.WriteString(stdin, request+"\n"); err != nil {
			return nil, err
		}
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), 2<<20)
	var response codexRPCResponse
	found := false
	for scanner.Scan() {
		var candidate codexRPCResponse
		if json.Unmarshal(scanner.Bytes(), &candidate) == nil && candidate.ID == 2 {
			response, found = candidate, true
			break
		}
	}
	_ = stdin.Close()
	_ = cmd.Wait()
	if !found {
		return nil, fmt.Errorf("hooks/list returned no response: %s", strings.TrimSpace(stderr.String()))
	}
	if response.Error != nil || len(response.Result.Data) != 1 {
		return nil, fmt.Errorf("hooks/list failed: %v", response.Error)
	}
	data := response.Result.Data[0]
	if len(data.Errors) > 0 || len(data.Warnings) > 0 {
		return nil, fmt.Errorf("hooks/list diagnostics: errors=%v warnings=%v", data.Errors, data.Warnings)
	}
	result := make([]struct{ Key, EventName, Source, CurrentHash, TrustStatus string }, 0, len(data.Hooks))
	for _, hook := range data.Hooks {
		if hook.Source != "sessionFlags" {
			continue
		}
		result = append(result, struct{ Key, EventName, Source, CurrentHash, TrustStatus string }{hook.Key, hook.EventName, hook.Source, hook.CurrentHash, hook.TrustStatus})
	}
	return result, nil
}
