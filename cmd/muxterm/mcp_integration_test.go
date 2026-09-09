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

// TestMCPToolsListReturns33Tools builds the binary, sends initialize followed
// by tools/list, and verifies the second stdout line lists exactly 33 tools
// in the expected order — all without a running sessiond daemon.
//
// This is the MANAGER surface: what a session that is not running inside a
// muxterm pane gets. The chief-of-staff sidecar and a shell on a laptop both
// see this list. Its lane counterpart is the test below.
//
// Tool count history: the count fell from 25 to 17 when a 13-tool family was
// retired alongside the HTTP proxy and list_tunnels/create_tunnel/close_tunnel
// (3) and get_config/update_config (2) were added. spawn_lane took it to 18,
// and the fleet trio (fleet_status, lane_transcript, session_send) to 21.
// list_machines, which answers "which machines can I reach", took it to 22.
// read_file and list_dir, which answer "what is IN a file on one of them",
// took it to 24. The publishing trio (publish_file, list_publications,
// revoke_publication), which serves one pinned file to anonymous callers,
// took it to 27. publish_folder, which serves a whole browsable directory
// tree to anonymous callers, took it to 28. view_file, which shows one local
// file to the human in the Viewer, took it to 29. The trigger quartet
// (create_trigger, list_triggers, set_trigger_enabled, delete_trigger), which
// starts lanes on a schedule or a file change with no human present, took it
// to 33.
func TestMCPToolsListReturns33Tools(t *testing.T) {
	bin := buildTestBinary(t)
	got := mcpToolNames(t, bin, "")

	wantTools := []string{
		// 16 sessiond-backed tools (terminal + workspace + layout + delegation + fleet)
		"run_command",
		"send_input",
		"get_screen",
		"list_workspaces",
		"create_workspace",
		"switch_workspace",
		"close_workspace",
		"create_pane",
		"rename_pane",
		"close_pane",
		"list_panes",
		"get_layout",
		"spawn_lane",
		"fleet_status",
		"lane_transcript",
		"session_send",
		// 1 machine tool (registered via registerMachineTools)
		"list_machines",
		// 2 read-only filesystem tools (registered via registerRemoteReadTools)
		"read_file",
		"list_dir",
		// 3 tunnel tools (HTTP REST, registered via registerTunnelTools)
		"list_tunnels",
		"create_tunnel",
		"close_tunnel",
		// 4 publishing tools (HTTP REST, registered via registerPublishTools)
		"publish_file",
		"publish_folder",
		"list_publications",
		"revoke_publication",
		// 1 artifact tool (HTTP REST, registered via registerArtifactTools)
		"view_file",
		// 2 config tools (HTTP REST, registered via registerConfigTools)
		"get_config",
		"update_config",
		// 4 trigger tools (registered via registerTriggerTools). LOCAL ONLY:
		// each one refuses a machine argument rather than ignoring it, because
		// creating unattended work on a machine you are not looking at is a
		// follow-on, not this surface.
		"create_trigger",
		"list_triggers",
		"set_trigger_enabled",
		"delete_trigger",
	}

	assertToolNames(t, got, wantTools)
}

// TestMCPToolsListInsidePaneWithholdsCloseTools is the LANE surface: what a
// session running inside a muxterm pane gets. close_workspace and close_pane
// are absent; everything else, spawn_lane and the fleet trio included, is not.
//
// A lane that cannot close a workspace cannot end its run by destroying the
// workspace its verdict, its PR number and its final report are sitting in --
// which is the failure this whole guard exists to prevent, observed in the
// wild before it was written. A lane that can still spawn_lane and read
// fleet_status has lost nothing it needs to do its work.
//
// It drives the real binary rather than calling registerAllTools directly,
// because the claim under test is about what an agent's MCP client actually
// receives over stdio, and the environment is the channel that carries it.
func TestMCPToolsListInsidePaneWithholdsCloseTools(t *testing.T) {
	bin := buildTestBinary(t)
	got := mcpToolNames(t, bin, "7")

	wantTools := []string{
		// 14 sessiond-backed tools: the 16 above, less the two closers.
		"run_command",
		"send_input",
		"get_screen",
		"list_workspaces",
		"create_workspace",
		"switch_workspace",
		"create_pane",
		"rename_pane",
		"list_panes",
		"get_layout",
		"spawn_lane",
		"fleet_status",
		"lane_transcript",
		"session_send",
		// 1 machine tool. Present in a pane too: knowing which machines
		// exist is not a destructive capability, and a lane that can see
		// the fleet has no reason to be blind to where it runs.
		"list_machines",
		// 2 read-only filesystem tools. Present in a pane for the same
		// reason: reading a file destroys nothing, and the guard above
		// withholds DESTRUCTIVE reach, not reach.
		"read_file",
		"list_dir",
		// 3 tunnel tools, unchanged.
		"list_tunnels",
		"create_tunnel",
		"close_tunnel",
		// 4 publishing tools, unchanged: publishing is not a destructive
		// capability against the workspace this lane's report sits in, and a
		// lane that can publish can hand a human a URL for what it produced.
		"publish_file",
		"publish_folder",
		"list_publications",
		"revoke_publication",
		// 1 artifact tool, present in a pane: view_file SHOWS a file to the
		// human who is already logged in. It publishes nothing, creates no
		// link and destroys nothing, so it falls on the same side of this
		// guard's line as read_file and the publishing four.
		"view_file",
		// 2 config tools, unchanged.
		"get_config",
		"update_config",
		// 1 of the 4 trigger tools. create_trigger, set_trigger_enabled and
		// delete_trigger are WITHHELD here, on the same principle as the two
		// closers and for a sharper reason: a lane that can create a trigger
		// can arrange for MORE LANES, on a schedule, indefinitely, with no
		// human ever having asked. list_triggers destroys nothing and answers
		// a question a lane has a real reason to ask -- is something else
		// about to fire into this repository while I work in it.
		"list_triggers",
	}

	assertToolNames(t, got, wantTools)

	// Stated separately from the ordered comparison above so a failure says
	// which forbidden tool came back, not merely that a list did not match.
	for _, name := range got {
		if name == "close_workspace" || name == "close_pane" ||
			name == "create_trigger" || name == "set_trigger_enabled" || name == "delete_trigger" {
			t.Errorf("%s is offered to a session inside a pane; it must be withheld", name)
		}
	}
}
