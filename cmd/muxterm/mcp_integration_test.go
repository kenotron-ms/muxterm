package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

// TestMCPToolsListReturns25Tools builds the binary, sends initialize followed
// by tools/list, and verifies the second stdout line lists exactly 25 tools
// in the expected order — all without a running sessiond daemon.
func TestMCPToolsListReturns25Tools(t *testing.T) {
	bin := buildTestBinary(t)

	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
	}, "\n") + "\n"

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, "mcp")
	cmd.Stdin = strings.NewReader(input)

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

	wantTools := []string{
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
		"browser_goto",
		"browser_go_back",
		"browser_go_forward",
		"browser_reload",
		"browser_click",
		"browser_fill",
		"browser_type",
		"browser_press",
		"browser_hover",
		"browser_select",
		"browser_snapshot",
		"browser_eval",
		"browser_screenshot",
	}

	tools := resp.Result.Tools
	if len(tools) != len(wantTools) {
		names := make([]string, len(tools))
		for i, t := range tools {
			names[i] = t.Name
		}
		t.Fatalf("tools/list returned %d tools, want %d\ngot:  %v\nwant: %v",
			len(tools), len(wantTools), names, wantTools)
	}
	for i, want := range wantTools {
		if tools[i].Name != want {
			t.Errorf("tools[%d].name = %q, want %q", i, tools[i].Name, want)
		}
	}
}
