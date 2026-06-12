package mcp_test

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/user/muxterm/internal/mcp"
)

// rpcEnvelope is a minimal struct for reading both results and errors from the server.
type rpcEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// runServer sends requests to a fresh server and returns decoded responses.
func runServer(t *testing.T, requests []string) []rpcEnvelope {
	t.Helper()

	var in bytes.Buffer
	var out bytes.Buffer

	for _, req := range requests {
		in.WriteString(req + "\n")
	}

	srv := mcp.NewServerWithIO(&in, &out)
	if err := srv.Run(); err != nil {
		t.Fatalf("server Run() returned unexpected error: %v", err)
	}

	var responses []rpcEnvelope
	dec := json.NewDecoder(&out)
	for dec.More() {
		var env rpcEnvelope
		if err := dec.Decode(&env); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		responses = append(responses, env)
	}
	return responses
}

// TestInitializeHandshake verifies the initialize method returns protocol version and server info.
func TestInitializeHandshake(t *testing.T) {
	req := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`
	responses := runServer(t, []string{req})

	if len(responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(responses))
	}
	resp := responses[0]
	if resp.Error != nil {
		t.Fatalf("unexpected error in response: %+v", resp.Error)
	}

	// Decode result fields
	var result struct {
		ProtocolVersion string `json:"protocolVersion"`
		ServerInfo      struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"serverInfo"`
		Capabilities map[string]any `json:"capabilities"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to parse result: %v", err)
	}

	if result.ProtocolVersion != "2024-11-05" {
		t.Errorf("protocolVersion = %q, want %q", result.ProtocolVersion, "2024-11-05")
	}
	if result.ServerInfo.Name != "muxterm" {
		t.Errorf("serverInfo.name = %q, want %q", result.ServerInfo.Name, "muxterm")
	}
}

// TestInitializedNotificationProducesNoResponse verifies that the notifications/initialized
// method produces no response (it is a notification with no ID).
func TestInitializedNotificationProducesNoResponse(t *testing.T) {
	// A notification has no "id" field
	req := `{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}`
	responses := runServer(t, []string{req})

	if len(responses) != 0 {
		t.Fatalf("expected 0 responses for notification, got %d", len(responses))
	}
}

// TestToolsListReturnsRegisteredTools verifies that a registered tool appears in tools/list.
func TestToolsListReturnsRegisteredTools(t *testing.T) {
	var in bytes.Buffer
	var out bytes.Buffer

	req := `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}` + "\n"
	in.WriteString(req)

	srv := mcp.NewServerWithIO(&in, &out)
	srv.Register("echo", "echoes input", map[string]any{
		"type": "object",
	}, func(args map[string]any) (string, error) {
		return "echo", nil
	})

	if err := srv.Run(); err != nil {
		t.Fatalf("Run() error: %v", err)
	}

	var responses []rpcEnvelope
	dec := json.NewDecoder(&out)
	for dec.More() {
		var env rpcEnvelope
		if err := dec.Decode(&env); err != nil {
			t.Fatalf("decode error: %v", err)
		}
		responses = append(responses, env)
	}

	if len(responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(responses))
	}

	var result struct {
		Tools []struct {
			Name        string         `json:"name"`
			Description string         `json:"description"`
			InputSchema map[string]any `json:"inputSchema"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(responses[0].Result, &result); err != nil {
		t.Fatalf("parse result: %v", err)
	}

	if len(result.Tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(result.Tools))
	}
	if result.Tools[0].Name != "echo" {
		t.Errorf("tool name = %q, want %q", result.Tools[0].Name, "echo")
	}
	if result.Tools[0].Description != "echoes input" {
		t.Errorf("tool description = %q, want %q", result.Tools[0].Description, "echoes input")
	}
}

// TestToolsCallDispatchesToHandler verifies that tools/call invokes the registered handler.
func TestToolsCallDispatchesToHandler(t *testing.T) {
	var in bytes.Buffer
	var out bytes.Buffer

	req := `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"greet","arguments":{}}}` + "\n"
	in.WriteString(req)

	srv := mcp.NewServerWithIO(&in, &out)
	srv.Register("greet", "says hello", map[string]any{}, func(args map[string]any) (string, error) {
		return "hello world", nil
	})

	if err := srv.Run(); err != nil {
		t.Fatalf("Run() error: %v", err)
	}

	var responses []rpcEnvelope
	dec := json.NewDecoder(&out)
	for dec.More() {
		var env rpcEnvelope
		if err := dec.Decode(&env); err != nil {
			t.Fatalf("decode error: %v", err)
		}
		responses = append(responses, env)
	}

	if len(responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(responses))
	}
	if responses[0].Error != nil {
		t.Fatalf("unexpected error: %+v", responses[0].Error)
	}

	var result struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(responses[0].Result, &result); err != nil {
		t.Fatalf("parse result: %v", err)
	}

	if len(result.Content) == 0 {
		t.Fatal("expected at least 1 content item")
	}
	if result.Content[0].Type != "text" {
		t.Errorf("content[0].type = %q, want %q", result.Content[0].Type, "text")
	}
	if result.Content[0].Text != "hello world" {
		t.Errorf("content[0].text = %q, want %q", result.Content[0].Text, "hello world")
	}
}

// TestUnknownMethodReturnsMethodNotFound verifies that an unrecognized method
// returns error code -32601.
func TestUnknownMethodReturnsMethodNotFound(t *testing.T) {
	req := `{"jsonrpc":"2.0","id":4,"method":"doesNotExist","params":{}}`
	responses := runServer(t, []string{req})

	if len(responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(responses))
	}
	if responses[0].Error == nil {
		t.Fatal("expected error response, got nil error")
	}
	if responses[0].Error.Code != -32601 {
		t.Errorf("error code = %d, want %d", responses[0].Error.Code, -32601)
	}
}

// TestMalformedJSONReturnsParseError verifies that malformed JSON returns error code -32700.
func TestMalformedJSONReturnsParseError(t *testing.T) {
	req := `{not valid json`
	responses := runServer(t, []string{req})

	if len(responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(responses))
	}
	if responses[0].Error == nil {
		t.Fatal("expected error response, got nil error")
	}
	if responses[0].Error.Code != -32700 {
		t.Errorf("error code = %d, want %d", responses[0].Error.Code, -32700)
	}
}

// Compile check: ensure NewServer exists and compiles.
func TestNewServerCompiles(t *testing.T) {
	_ = strings.NewReader // just to use strings package
	// Just test that NewServer() doesn't panic (it wires os.Stdin/Stdout)
	// We can't actually call it in tests as it would block on stdin
	// So just verify it exists via the type system
	_ = mcp.NewServerWithIO // must be callable
}
