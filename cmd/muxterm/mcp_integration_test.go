package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// buildTestBinary compiles the muxterm binary into a temp directory and
// returns the path to the executable. Tests that call this are skipped when
// the build fails (e.g. missing CGO on CI without PTY support).
func buildTestBinary(t *testing.T) string {
	t.Helper()
	binDir := t.TempDir()
	bin := filepath.Join(binDir, "muxterm")
	cmd := exec.Command("go", "build", "-o", bin, ".")
	var buildOut bytes.Buffer
	cmd.Stdout = &buildOut
	cmd.Stderr = &buildOut
	if err := cmd.Run(); err != nil {
		t.Skipf("build failed (skipping integration test): %v\n%s", err, buildOut.String())
	}
	return bin
}

// TestMCPInitializeOverStdio builds the muxterm binary, pipes a single
// JSON-RPC initialize request to 'muxterm mcp', and asserts that the first
// stdout line is a valid JSON-RPC 2.0 response with:
//
//   - jsonrpc == "2.0"
//   - id == 1
//   - result.protocolVersion == "2024-11-05"
//   - result.serverInfo.name == "muxterm"
//
// No sessiond daemon is required — initialize must work without one.
func TestMCPInitializeOverStdio(t *testing.T) {
	bin := buildTestBinary(t)

	initReq := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}` + "\n"

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, "mcp")
	cmd.Stdin = strings.NewReader(initReq)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		t.Fatalf("muxterm mcp failed: %v\nstderr: %s\nstdout: %s",
			err, stderr.String(), stdout.String())
	}

	// First non-empty line of stdout is the initialize response.
	firstLine := ""
	for _, line := range strings.Split(stdout.String(), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			firstLine = line
			break
		}
	}
	if firstLine == "" {
		t.Fatalf("no output on stdout\nstderr: %s", stderr.String())
	}

	var resp struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Result  struct {
			ProtocolVersion string `json:"protocolVersion"`
			ServerInfo      struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
		} `json:"result"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(firstLine), &resp); err != nil {
		t.Fatalf("decode stdout line %q: %v", firstLine, err)
	}

	if resp.Error != nil {
		t.Fatalf("unexpected JSON-RPC error: code=%d message=%q", resp.Error.Code, resp.Error.Message)
	}
	if resp.JSONRPC != "2.0" {
		t.Errorf("jsonrpc = %q, want %q", resp.JSONRPC, "2.0")
	}
	if string(resp.ID) != "1" {
		t.Errorf("id = %s, want 1", resp.ID)
	}
	if resp.Result.ProtocolVersion != "2024-11-05" {
		t.Errorf("protocolVersion = %q, want %q", resp.Result.ProtocolVersion, "2024-11-05")
	}
	if resp.Result.ServerInfo.Name != "muxterm" {
		t.Errorf("serverInfo.name = %q, want %q", resp.Result.ServerInfo.Name, "muxterm")
	}
}

// mcpToolNames runs `muxterm mcp` with paneID as its sessiond.EnvPaneID and
// returns the tool names from tools/list, in server order.
//
// paneID == "" means "not inside a muxterm pane". It is passed EXPLICITLY
// rather than inherited, and that is the point of this helper: this repo is
// developed inside muxterm, so `go test` is routinely run from a pane, whose
// environment now carries EnvPaneID. Without the override the manager-surface
// test below would pass or fail depending on which terminal the developer
// happened to run it from.
func mcpToolNames(t *testing.T, bin, paneID string) []string {
	t.Helper()

	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
	}, "\n") + "\n"

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, "mcp")
	cmd.Stdin = strings.NewReader(input)

	env := make([]string, 0, len(os.Environ())+1)
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, sessiond.EnvPaneID+"=") {
			env = append(env, kv)
		}
	}
	if paneID != "" {
		env = append(env, sessiond.EnvPaneID+"="+paneID)
	}
	cmd.Env = env

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		t.Fatalf("muxterm mcp failed: %v\nstderr: %s\nstdout: %s",
			err, stderr.String(), stdout.String())
	}

	lines := []string{}
	for _, line := range strings.Split(stdout.String(), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) < 2 {
		t.Fatalf("expected at least 2 output lines, got %d\nstdout: %s\nstderr: %s",
			len(lines), stdout.String(), stderr.String())
	}

	// Second line is the tools/list response.
	var resp struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(lines[1]), &resp); err != nil {
		t.Fatalf("decode tools/list response %q: %v", lines[1], err)
	}
	if resp.Error != nil {
		t.Fatalf("tools/list returned error: code=%d message=%q", resp.Error.Code, resp.Error.Message)
	}

	names := make([]string, len(resp.Result.Tools))
	for i, tool := range resp.Result.Tools {
		names[i] = tool.Name
	}
	return names
}

// assertToolNames compares got against want elementwise, reporting the whole
// list on a length mismatch so a failure names what actually changed.
func assertToolNames(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("tools/list returned %d tools, want %d\ngot:  %v\nwant: %v",
			len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("tools[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// expectedMCPTools records the scoped agent surface in registration order.
// Keep this inventory aligned with the real tools/list protocol response.
var expectedMCPTools = []string{
	"get_screen",
	"list_workspaces",
	"create_workspace",
	"switch_workspace",
	"create_pane",
	"rename_pane",
	"list_panes",
	"get_layout",
	"fleet_status",
	"lane_transcript",
	"list_machines",
	"read_file",
	"list_dir",
	"list_tunnels",
	"create_tunnel",
	"close_tunnel",
	"publish_file",
	"publish_folder",
	"list_publications",
	"revoke_publication",
	"report_goal_evidence",
	"get_chat_goal",
	"control_chat_goal",
	"get_operator_lanes",
	"list_chats",
	"search_chats",
	"list_projects",
	"list_chat_sessions",
	"spawn_chat",
	"send_chat_message",
	"read_chat_session",
	"create_chat",
	"get_chat_transcript",
	"get_chat_summary",
	"list_remotes",
	"add_remote",
	"connect_remote",
	"disconnect_remote",
	"remove_remote",
	"navigate_app",
	"view_file",
	"get_chat_pages",
	"get_config",
	"update_config",
	"browser_action",
	"get_browser_action",
	"stop_browser_control",
	"list_browser_assistants",
	"request_browser_snapshot",
	"get_browser_snapshot_request",
	"prepare_connection",
	"configure_connection",
	"check_connection",
	"cancel_connection_setup",
	"list_triggers",
}

// TestMCPToolsListReturns55Tools checks the manager's advertised surface.
func TestMCPToolsListReturns55Tools(t *testing.T) {
	bin := buildTestBinary(t)
	assertToolNames(t, mcpToolNames(t, bin, ""), expectedMCPTools)
}

// TestMCPToolsListInsidePaneWithholdsCloseTools checks the pane surface and
// guards against exposing destructive workspace or trigger controls.
func TestMCPToolsListInsidePaneWithholdsCloseTools(t *testing.T) {
	bin := buildTestBinary(t)
	got := mcpToolNames(t, bin, "7")
	assertToolNames(t, got, expectedMCPTools)
	for _, name := range got {
		switch name {
		case "close_workspace", "close_pane", "create_trigger", "set_trigger_enabled", "delete_trigger":
			t.Errorf("%s is offered to a session inside a pane; it must be withheld", name)
		}
	}
}
