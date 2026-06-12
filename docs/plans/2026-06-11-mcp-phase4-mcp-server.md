# MCP Agent Workbench — Phase 4: `muxterm mcp` Server — Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Ship a working `muxterm mcp` subcommand — a JSON-RPC 2.0 MCP server over stdio that connects directly to the local sessiond Unix socket and exposes terminal, workspace, and layout tools that AI agents can call.

**Architecture:** The MCP server is a thin stdio JSON-RPC loop (`internal/mcp/server.go`) that registers tools and dispatches `tools/call` to handlers. A connection wrapper (`internal/mcp/client.go`) attaches to a workspace on the sessiond Unix socket as just another subscriber, buffers per-pane output, and resolves OSC 133 shell-prompt events so `run_command` knows when a command finished. Browser tools are deferred to Phase 5 — Phase 4 ships terminal + workspace + layout tools only.

**Tech Stack:** Go (stdlib `encoding/json`, `bufio`, `net`), the existing `internal/sessiond` Unix-socket client, the frozen `sessiond.Message` wire protocol.

---

## READ THIS FIRST — Orientation for the implementer

You know nothing about this codebase. That is fine. Here is everything you need.

### What Phase 4 produces

A new subcommand. After this phase, running:

```
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | ./bin/muxterm mcp
```

prints a valid MCP `initialize` response on stdout. With a sessiond daemon running, an agent can call `tools/list` and then `tools/call` to run commands, manage workspaces, and inspect the layout.

### The MCP wire protocol (JSON-RPC 2.0 over stdio)

One JSON object per line on stdin; one JSON object per line on stdout. **stdout is the transport — never print logs or debug output to stdout. Log to stderr only.**

- `initialize` (request, has `id`) → reply with server capabilities.
- `notifications/initialized` (notification, **no `id`**) → do nothing, write no response.
- `ping` (request) → reply with an empty result object.
- `tools/list` (request) → reply with the registered tools array.
- `tools/call` (request, `params.name` + `params.arguments`) → dispatch to the registered tool, wrap its string output as `{"content":[{"type":"text","text":"..."}]}`.
- Unknown method → error `-32601`. Malformed JSON line → error `-32700`.

A tool that returns a Go `error` becomes a JSON-RPC `error` response (use code `-32603` "internal error" unless a more specific code is obvious, e.g. `-32602` for bad arguments).

### ⚠️ EXPLORE `internal/sessiond/` BEFORE WRITING ANY CLIENT CODE

The architecture notes you were handed describe an idealized API. **The real API differs in several important ways.** Read `internal/sessiond/client.go`, `protocol.go`, and `spawn.go` yourself and confirm each of these before coding. These were verified against the current `main` branch:

1. **`sessiond.Dial` takes ONLY a socket path — there is NO `Handlers` argument.**
   Real signature: `func Dial(socketPath string) (*Client, error)`.
   Handlers are installed *separately* via `func (c *Client) SetHandlers(h Handlers)`.

2. **The read loop must be started manually.** `func (c *Client) Run() error` is a blocking read loop. Per its doc comment: *"Run MUST be started in its own goroutine before any requests are issued."* So the wiring is: `Dial` → `SetHandlers` → `go client.Run()` → then issue requests.

3. **`sessiond.SocketPath()` returns `(string, error)`** — not a bare string. Error-check it.

4. **`Handlers` has NO `OnShellPrompt` field, and `dispatchEvent` has NO `TypeShellPrompt` case** — *yet the daemon already broadcasts shell-prompt events.* (See `internal/sessiond/server.go` `onPromptFn`, which sets `WorkspaceID` + `PaneID`, and `internal/sessiond/pane.go` which emits `&Message{Type: TypeShellPrompt, ExitCode: code}`.) **Task 2 adds the missing handler + dispatch case to `internal/sessiond/`** — this is a real prerequisite, not optional.

5. **Input is `func (c *Client) Input(paneID uint32, data []byte) error`** — there is NO `SendInput` method. Note `paneID` is a `uint32` here (it is an `int` almost everywhere else).

6. **There are NO `ScreenSnapshot` or `GetLayout` client methods.** The daemon *server* already handles `TypeScreenSnapshot`→`TypeScreenSnapshotResult` and `TypeGetLayout`→`TypeLayoutResult` (see `internal/sessiond/server.go`), but the `Client.request` method is **private**, so you cannot call these from `internal/mcp`. **Task 2 adds public `ScreenSnapshot` and `GetLayout` wrapper methods to `internal/sessiond/client.go`.**

7. **Methods that DO exist on `*sessiond.Client`** (use these as-is): `ListWorkspaces() ([]WorkspaceInfo, error)`, `CreateWorkspace(name string) (string, error)`, `RenameWorkspace(id, name string) error`, `CloseWorkspace(id string) error`, `Attach(workspaceID, breakpoint string) (Composition, error)`, `CreatePane(cmd []string) (int, error)`, `CreateBrowserPane(port int, path string, headers map[string]string) (int, error)`, `ClosePane(paneID int) error`, `RenamePane(paneID int, name string) error`.

8. **The `Message` envelope** (`internal/sessiond/protocol.go`) is one big struct shared by every request/reply/event. Relevant fields: `Type`, `PaneID int`, `Name`, `WorkspaceID`, `Text`, `ExitCode int`, `Cursor *CursorPos`, `ASCII string`, `Workspaces []WorkspaceInfo`, `Panes []PaneInfo`. Type constants you need already exist: `TypeScreenSnapshot`, `TypeScreenSnapshotResult`, `TypeGetLayout`, `TypeLayoutResult`, `TypeShellPrompt`.

### Test helpers you will reuse (in `internal/sessiond/*_test.go`)

These are in `package sessiond`, so you can only call them from tests **inside that package**. For `internal/mcp` tests you will spin up a real sessiond server via its exported API. Read `internal/sessiond/server_test.go` lines 14–87 for the patterns (`startTestServer`, `dialMust`, `readControlUntil`, `writeControlMust`). For `internal/mcp`, prefer constructing a server with `sessiond.NewServer(socketPath)` + `go srv.ListenAndServe(ctx)` and connecting your `mcp.Client` to it.

### Commands you will run (memorize these)

- Build gate (every task): `go build ./...`
- Package tests: `go test ./internal/mcp/...`
- sessiond regression (Task 2 touches it): `go test ./internal/sessiond/...`
- Full build for the binary: `go build -o bin/muxterm ./cmd/muxterm`

### Commit style

Conventional commits: `feat:`, `test:`, `fix:`, `chore:`. **Commit after every task.**

### Scope discipline

Phase 4 is terminal + workspace + layout tools over **stdio only**. SSE transport and all **browser** tools are **Phase 5** — do not implement them. Where a tool description mentions browser automation, it is fine to reference "see playwright-cli (browser tools land in Phase 5)" but register no browser tool.

---

## Task 1: MCP server scaffold (`internal/mcp/server.go`)

**Files:**
- Create: `internal/mcp/server.go`
- Test: `internal/mcp/server_test.go`

**Step 1: Write the failing test.**

Create `internal/mcp/server_test.go`. The server reads from an `io.Reader` and writes to an `io.Writer` — design `NewServer` to accept those so tests use `bytes.Buffer` instead of real stdin/stdout. (The production `cmd` path passes `os.Stdin`/`os.Stdout`.)

```go
package mcp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// runLines feeds each input line through a fresh Server and returns the
// decoded JSON-RPC responses written to stdout, in order. Notifications that
// produce no output contribute no response.
func runLines(t *testing.T, register func(*Server), lines ...string) []map[string]any {
	t.Helper()
	in := strings.NewReader(strings.Join(lines, "\n") + "\n")
	var out bytes.Buffer
	srv := NewServerWithIO(in, &out)
	if register != nil {
		register(srv)
	}
	if err := srv.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	var got []map[string]any
	sc := bufio.NewScanner(&out)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("decode response %q: %v", line, err)
		}
		got = append(got, m)
	}
	return got
}

func TestInitializeHandshake(t *testing.T) {
	got := runLines(t, nil,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}`,
	)
	if len(got) != 1 {
		t.Fatalf("want 1 response, got %d: %v", len(got), got)
	}
	res, ok := got[0]["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result object: %v", got[0])
	}
	if res["protocolVersion"] != "2024-11-05" {
		t.Errorf("protocolVersion = %v", res["protocolVersion"])
	}
	si, _ := res["serverInfo"].(map[string]any)
	if si["name"] != "muxterm" {
		t.Errorf("serverInfo.name = %v", si)
	}
}

func TestInitializedNotificationProducesNoResponse(t *testing.T) {
	got := runLines(t, nil, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	if len(got) != 0 {
		t.Fatalf("notification must produce no response, got %v", got)
	}
}

func TestToolsListReturnsRegisteredTools(t *testing.T) {
	reg := func(s *Server) {
		s.Register("echo", "echo the input", map[string]any{"type": "object"},
			func(args map[string]any) (string, error) { return "ok", nil })
	}
	got := runLines(t, reg, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	res := got[0]["result"].(map[string]any)
	tools := res["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("want 1 tool, got %d", len(tools))
	}
	first := tools[0].(map[string]any)
	if first["name"] != "echo" || first["description"] != "echo the input" {
		t.Errorf("tool metadata wrong: %v", first)
	}
}

func TestToolsCallDispatchesToHandler(t *testing.T) {
	reg := func(s *Server) {
		s.Register("greet", "greet", map[string]any{"type": "object"},
			func(args map[string]any) (string, error) {
				return "hello " + args["who"].(string), nil
			})
	}
	got := runLines(t, reg,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"greet","arguments":{"who":"world"}}}`,
	)
	res := got[0]["result"].(map[string]any)
	content := res["content"].([]any)
	first := content[0].(map[string]any)
	if first["type"] != "text" || first["text"] != "hello world" {
		t.Errorf("content wrong: %v", content)
	}
}

func TestUnknownMethodReturnsMethodNotFound(t *testing.T) {
	got := runLines(t, nil, `{"jsonrpc":"2.0","id":9,"method":"no/such/method"}`)
	errObj := got[0]["error"].(map[string]any)
	if int(errObj["code"].(float64)) != -32601 {
		t.Errorf("code = %v, want -32601", errObj["code"])
	}
}

func TestMalformedJSONReturnsParseError(t *testing.T) {
	got := runLines(t, nil, `{not valid json`)
	errObj := got[0]["error"].(map[string]any)
	if int(errObj["code"].(float64)) != -32700 {
		t.Errorf("code = %v, want -32700", errObj["code"])
	}
}
```

**Step 2: Run the test to verify it fails.**

Run: `go test ./internal/mcp/...`
Expected: FAIL — package `internal/mcp` does not exist / `NewServerWithIO` undefined.

**Step 3: Write the minimal implementation.**

Create `internal/mcp/server.go`:

```go
// Package mcp implements a JSON-RPC 2.0 Model Context Protocol server over
// stdio for muxterm. Agents speak MCP on stdin/stdout; the server bridges
// tool calls to the local sessiond daemon.
package mcp

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
)

// protocolVersion is the MCP protocol revision this server speaks.
const protocolVersion = "2024-11-05"

// serverVersion is the advertised muxterm MCP server version.
const serverVersion = "0.1.0"

// JSON-RPC error codes used by this server.
const (
	codeParseError    = -32700
	codeInvalidParams = -32602
	codeMethodNotFound = -32601
	codeInternalError  = -32603
)

// ToolFunc is a tool handler: it receives the decoded arguments object and
// returns a text result or an error (which becomes a JSON-RPC error response).
type ToolFunc func(args map[string]any) (string, error)

// tool bundles a registered tool's metadata and handler.
type tool struct {
	name        string
	description string
	schema      map[string]any
	fn          ToolFunc
}

// Server is a JSON-RPC 2.0 MCP server reading newline-delimited requests from
// an input stream and writing responses to an output stream.
type Server struct {
	in    *bufio.Reader
	out   *json.Encoder
	tools map[string]*tool
	order []string // registration order, for stable tools/list output
}

// NewServer returns a Server wired to os.Stdin and os.Stdout.
func NewServer() *Server {
	return NewServerWithIO(os.Stdin, os.Stdout)
}

// NewServerWithIO returns a Server reading from in and writing to out. Used by
// tests with bytes.Buffer; production uses NewServer.
func NewServerWithIO(in io.Reader, out io.Writer) *Server {
	return &Server{
		in:    bufio.NewReader(in),
		out:   json.NewEncoder(out),
		tools: make(map[string]*tool),
	}
}

// Register adds a tool with its JSON Schema and handler. Re-registering a name
// overwrites it but keeps its original list position.
func (s *Server) Register(name, description string, schema map[string]any, fn ToolFunc) {
	if _, exists := s.tools[name]; !exists {
		s.order = append(s.order, name)
	}
	s.tools[name] = &tool{name: name, description: description, schema: schema, fn: fn}
}

// rpcRequest is the inbound JSON-RPC envelope. ID is json.RawMessage so we can
// echo it back verbatim (and detect notifications, which omit it).
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Run reads requests until EOF, dispatching each line. It returns nil on a
// clean EOF and any non-EOF read error otherwise.
func (s *Server) Run() error {
	for {
		line, err := s.in.ReadString('\n')
		if len(line) > 0 {
			s.handleLine(line)
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

// handleLine parses a single request line and dispatches it by method.
func (s *Server) handleLine(line string) {
	var req rpcRequest
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		s.writeError(nil, codeParseError, "parse error")
		return
	}
	// A request without an id is a notification: never reply.
	isNotification := len(req.ID) == 0
	switch req.Method {
	case "initialize":
		s.handleInitialize(req.ID)
	case "notifications/initialized":
		// no-op, no response
	case "ping":
		if !isNotification {
			s.writeResult(req.ID, map[string]any{})
		}
	case "tools/list":
		s.handleToolsList(req.ID)
	case "tools/call":
		s.handleToolsCall(req.ID, req.Params)
	default:
		if !isNotification {
			s.writeError(req.ID, codeMethodNotFound, "method not found: "+req.Method)
		}
	}
}

func (s *Server) handleInitialize(id json.RawMessage) {
	s.writeResult(id, map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo":      map[string]any{"name": "muxterm", "version": serverVersion},
	})
}

func (s *Server) handleToolsList(id json.RawMessage) {
	list := make([]map[string]any, 0, len(s.order))
	for _, name := range s.order {
		t := s.tools[name]
		list = append(list, map[string]any{
			"name":        t.name,
			"description": t.description,
			"inputSchema": t.schema,
		})
	}
	s.writeResult(id, map[string]any{"tools": list})
}

func (s *Server) handleToolsCall(id, params json.RawMessage) {
	var p struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		s.writeError(id, codeInvalidParams, "invalid params")
		return
	}
	t, ok := s.tools[p.Name]
	if !ok {
		s.writeError(id, codeMethodNotFound, "unknown tool: "+p.Name)
		return
	}
	text, err := t.fn(p.Arguments)
	if err != nil {
		s.writeError(id, codeInternalError, err.Error())
		return
	}
	s.writeResult(id, map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
	})
}

// rpcResponse is the outbound envelope. Exactly one of Result/Error is set.
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *Server) writeResult(id json.RawMessage, result any) {
	if id == nil {
		id = json.RawMessage("null")
	}
	_ = s.out.Encode(rpcResponse{JSONRPC: "2.0", ID: id, Result: result})
}

func (s *Server) writeError(id json.RawMessage, code int, msg string) {
	if id == nil {
		id = json.RawMessage("null")
	}
	_ = s.out.Encode(rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}})
}
```

> Note: `json.Encoder.Encode` appends a newline after each object — exactly the newline-delimited framing MCP wants. Do not add your own.

**Step 4: Run the test to verify it passes.**

Run: `go test ./internal/mcp/...`
Expected: PASS (all 6 tests).

**Step 5: Build gate.**

Run: `go build ./...`
Expected: success, no output.

**Step 6: Commit.**

```
git add internal/mcp/server.go internal/mcp/server_test.go && git commit -m "feat: add MCP JSON-RPC stdio server scaffold"
```

---

## Task 2: sessiond client extensions + MCP connection wrapper

This task has **two parts**. Part A adds the three missing pieces to `internal/sessiond` (the shell-prompt handler and the screen-snapshot / get-layout client methods — see READ THIS FIRST findings #4 and #6). Part B builds the MCP-side connection wrapper that uses them.

**Files:**
- Modify: `internal/sessiond/client.go`
- Test: `internal/sessiond/client_test.go` (add cases) — or a new `internal/sessiond/mcp_methods_test.go`
- Create: `internal/mcp/client.go`
- Test: `internal/mcp/client_test.go`

### Part A — sessiond client extensions

**Step 1: Write the failing sessiond test.**

Create `internal/sessiond/mcp_methods_test.go` (package `sessiond`, so the test helpers are in scope):

```go
package sessiond

import (
	"context"
	"testing"
	"time"
)

func TestClientScreenSnapshotAndGetLayout(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	c, err := Dial(socketPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	go func() { _ = c.Run() }()

	id, err := c.CreateWorkspace("ws")
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if _, err := c.Attach(id, "wide"); err != nil {
		t.Fatalf("Attach: %v", err)
	}
	paneID, err := c.CreatePane(nil)
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	// get-layout returns an ASCII diagram (non-empty once a pane exists).
	ascii, err := c.GetLayout()
	if err != nil {
		t.Fatalf("GetLayout: %v", err)
	}
	if ascii == "" {
		t.Errorf("GetLayout returned empty ASCII")
	}

	// screen-snapshot returns text + cursor without error.
	snap, err := c.ScreenSnapshot(paneID)
	if err != nil {
		t.Fatalf("ScreenSnapshot: %v", err)
	}
	if snap.Cursor == nil {
		t.Errorf("ScreenSnapshot returned nil cursor")
	}
}

func TestClientOnShellPromptFires(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	c, err := Dial(socketPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()

	got := make(chan int, 1)
	c.SetHandlers(Handlers{
		OnShellPrompt: func(paneID, exitCode int) {
			select {
			case got <- exitCode:
			default:
			}
		},
	})
	go func() { _ = c.Run() }()

	id, _ := c.CreateWorkspace("ws")
	if _, err := c.Attach(id, "wide"); err != nil {
		t.Fatalf("Attach: %v", err)
	}
	paneID, err := c.CreatePane([]string{"/bin/sh", "-c", "printf '\\033]133;D;0\\007'; sleep 0.1"})
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}
	_ = paneID

	select {
	case code := <-got:
		if code != 0 {
			t.Errorf("exit code = %d, want 0", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("OnShellPrompt never fired")
	}
	_ = context.Background()
}
```

> If `CreatePane` with a custom argv is not viable on the test runner's `/bin/sh`, fall back to asserting `OnShellPrompt` wiring with a lighter approach — but try the argv path first; the daemon scans PTY output for the OSC 133 `;D` marker (see `internal/sessiond/pane.go` `scanOSC133`).

**Step 2: Run to verify it fails.**

Run: `go test ./internal/sessiond/ -run 'ScreenSnapshot|OnShellPrompt' -v`
Expected: FAIL — `c.GetLayout`, `c.ScreenSnapshot`, and `Handlers.OnShellPrompt` are undefined.

**Step 3: Add `OnShellPrompt` to the `Handlers` struct.**

In `internal/sessiond/client.go`, add this field to the `Handlers` struct (place it after `OnLayoutCommand`):

```go
	// OnShellPrompt fires when the daemon broadcasts an OSC 133 command-done
	// marker for paneID, carrying the command's exitCode. Used by the MCP
	// server to detect run_command completion.
	OnShellPrompt func(paneID int, exitCode int)
```

**Step 4: Add the `TypeShellPrompt` dispatch case.**

In `dispatchEvent` (the `switch msg.Type` block near the bottom of `client.go`), add a case alongside the others:

```go
	case TypeShellPrompt:
		if h.OnShellPrompt != nil {
			h.OnShellPrompt(msg.PaneID, msg.ExitCode)
		}
```

**Step 5: Add the `ScreenSnapshot` and `GetLayout` request methods.**

Add these methods to `internal/sessiond/client.go` (next to the other request wrappers like `Attach`):

```go
// ScreenSnapshot requests the VT grid snapshot for the pane identified by the
// workspace-local paneID. The reply carries the plain-text screen (msg.Text)
// and cursor position (msg.Cursor). It targets the attached workspace.
func (c *Client) ScreenSnapshot(paneID int) (*Message, error) {
	return c.request(&Message{Type: TypeScreenSnapshot, PaneID: paneID})
}

// GetLayout requests the ASCII layout diagram for the attached workspace and
// returns the diagram string from the layout-result reply.
func (c *Client) GetLayout() (string, error) {
	reply, err := c.request(&Message{Type: TypeGetLayout})
	if err != nil {
		return "", err
	}
	return reply.ASCII, nil
}
```

**Step 6: Run the sessiond tests.**

Run: `go test ./internal/sessiond/...`
Expected: PASS, including the two new tests and all existing regression tests.

**Step 7: Commit Part A.**

```
git add internal/sessiond/client.go internal/sessiond/mcp_methods_test.go && git commit -m "feat: add OnShellPrompt handler and ScreenSnapshot/GetLayout client methods to sessiond"
```

### Part B — MCP connection wrapper

**Step 8: Write the failing MCP client test.**

Create `internal/mcp/client_test.go`. It stands up a real sessiond server using the exported `sessiond.NewServer` + `ListenAndServe`, then exercises the wrapper:

```go
package mcp

import (
	"context"
	"testing"
	"time"

	"github.com/user/muxterm/internal/sessiond"
)

// startSessiond starts a real sessiond server on a temp socket and returns the
// socket path. It registers cleanup that cancels the server.
func startSessiond(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	socketPath := dir + "/sessiond.sock"
	srv, err := sessiond.NewServer(socketPath)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = srv.ListenAndServe(ctx) }()
	t.Cleanup(cancel)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if sessiond.IsAlive(socketPath) {
			return socketPath
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("sessiond did not come up at %s", socketPath)
	return ""
}

func TestDialAndAttach(t *testing.T) {
	socketPath := startSessiond(t)
	c, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer c.Close()

	wsID, err := c.conn.CreateWorkspace("ws")
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if err := c.AttachWorkspace(wsID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}
	if c.workspace != wsID {
		t.Errorf("workspace = %q, want %q", c.workspace, wsID)
	}
}

func TestOutputBufferAccumulates(t *testing.T) {
	socketPath := startSessiond(t)
	c, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer c.Close()

	wsID, _ := c.conn.CreateWorkspace("ws")
	if err := c.AttachWorkspace(wsID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}
	paneID, err := c.conn.CreatePane([]string{"/bin/sh", "-c", "printf hello; sleep 0.2"})
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if len(c.OutputBuffer(paneID)) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := string(c.OutputBuffer(paneID)); got == "" {
		t.Errorf("output buffer empty, expected pane output")
	}
}

func TestWaitForPromptResolves(t *testing.T) {
	socketPath := startSessiond(t)
	c, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer c.Close()

	wsID, _ := c.conn.CreateWorkspace("ws")
	if err := c.AttachWorkspace(wsID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}
	paneID, err := c.conn.CreatePane(nil) // default shell
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	c.ArmPrompt(paneID)
	// Drive a command that emits an OSC 133 done marker on completion. Many
	// shells with shell-integration do this; to be deterministic we emit it
	// explicitly.
	if err := c.conn.Input(uint32(paneID), []byte("printf '\\033]133;D;0\\007'\n")); err != nil {
		t.Fatalf("Input: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	code, err := c.WaitForPrompt(ctx, paneID)
	if err != nil {
		t.Fatalf("WaitForPrompt: %v", err)
	}
	if code != 0 {
		t.Errorf("exit code = %d, want 0", code)
	}
}
```

**Step 9: Run to verify it fails.**

Run: `go test ./internal/mcp/ -run 'Dial|OutputBuffer|WaitForPrompt' -v`
Expected: FAIL — `DialSocket`, `Client`, `AttachWorkspace`, etc. undefined.

**Step 10: Write the MCP connection wrapper.**

Create `internal/mcp/client.go`:

```go
package mcp

import (
	"context"
	"sync"

	"github.com/user/muxterm/internal/sessiond"
)

// Client wraps a sessiond connection for MCP server use: it attaches to one
// workspace at a time, buffers per-pane output, and resolves OSC 133
// shell-prompt events so run_command can detect command completion.
type Client struct {
	conn *sessiond.Client

	mu          sync.Mutex
	workspace   string                // currently attached workspace id
	outputBufs  map[int][]byte        // pane id -> accumulated raw output
	promptChans map[int]chan int      // pane id -> exit-code channel (armed per command)
}

// Dial connects to the local sessiond daemon at the default socket path.
func Dial() (*Client, error) {
	socketPath, err := sessiond.SocketPath()
	if err != nil {
		return nil, err
	}
	return DialSocket(socketPath)
}

// DialSocket connects to the sessiond daemon at socketPath, installs handlers,
// and starts the background read loop. Used directly by tests.
func DialSocket(socketPath string) (*Client, error) {
	conn, err := sessiond.Dial(socketPath)
	if err != nil {
		return nil, err
	}
	c := &Client{
		conn:        conn,
		outputBufs:  make(map[int][]byte),
		promptChans: make(map[int]chan int),
	}
	conn.SetHandlers(sessiond.Handlers{
		OnPaneOutput: func(paneID uint32, data []byte) {
			c.mu.Lock()
			c.outputBufs[int(paneID)] = append(c.outputBufs[int(paneID)], data...)
			c.mu.Unlock()
		},
		OnShellPrompt: func(paneID int, exitCode int) {
			c.mu.Lock()
			ch := c.promptChans[paneID]
			c.mu.Unlock()
			if ch != nil {
				select {
				case ch <- exitCode:
				default:
				}
			}
		},
	})
	go func() { _ = conn.Run() }()
	return c, nil
}

// Close closes the underlying sessiond connection.
func (c *Client) Close() error { return c.conn.Close() }

// AttachWorkspace attaches the connection to workspaceID and records it as the
// active workspace. Output buffers and prompt channels are reset.
func (c *Client) AttachWorkspace(workspaceID string) error {
	if _, err := c.conn.Attach(workspaceID, "wide"); err != nil {
		return err
	}
	c.mu.Lock()
	c.workspace = workspaceID
	c.outputBufs = make(map[int][]byte)
	c.promptChans = make(map[int]chan int)
	c.mu.Unlock()
	return nil
}

// Workspace returns the currently attached workspace id ("" if none).
func (c *Client) Workspace() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.workspace
}

// OutputBuffer returns a copy of the accumulated raw output for paneID.
func (c *Client) OutputBuffer(paneID int) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	b := c.outputBufs[paneID]
	out := make([]byte, len(b))
	copy(out, b)
	return out
}

// ClearOutput discards the accumulated output for paneID. Call before sending
// a command so the buffer holds only that command's output.
func (c *Client) ClearOutput(paneID int) {
	c.mu.Lock()
	delete(c.outputBufs, paneID)
	c.mu.Unlock()
}

// ArmPrompt installs a fresh prompt channel for paneID so the next
// shell-prompt event is delivered to a subsequent WaitForPrompt call.
func (c *Client) ArmPrompt(paneID int) {
	c.mu.Lock()
	c.promptChans[paneID] = make(chan int, 1)
	c.mu.Unlock()
}

// WaitForPrompt blocks until a shell-prompt event arrives for paneID or ctx is
// done. ArmPrompt must have been called first. Returns the command exit code.
func (c *Client) WaitForPrompt(ctx context.Context, paneID int) (int, error) {
	c.mu.Lock()
	ch := c.promptChans[paneID]
	c.mu.Unlock()
	if ch == nil {
		c.ArmPrompt(paneID)
		c.mu.Lock()
		ch = c.promptChans[paneID]
		c.mu.Unlock()
	}
	select {
	case code := <-ch:
		c.mu.Lock()
		delete(c.promptChans, paneID)
		c.mu.Unlock()
		return code, nil
	case <-ctx.Done():
		return -1, ctx.Err()
	}
}
```

> The test reaches into unexported fields (`c.conn`, `c.workspace`) — that is fine because the test is in `package mcp`.

**Step 11: Run the MCP client tests.**

Run: `go test ./internal/mcp/...`
Expected: PASS (Task 1 tests still green, plus the three new ones).

**Step 12: Build gate.**

Run: `go build ./...`
Expected: success.

**Step 13: Commit Part B.**

```
git add internal/mcp/client.go internal/mcp/client_test.go && git commit -m "feat: add MCP sessiond connection wrapper with output buffering and prompt waits"
```

---

## Task 3: Terminal tools

**Files:**
- Create: `internal/mcp/ansi.go`
- Create: `internal/mcp/tools_terminal.go`
- Test: `internal/mcp/ansi_test.go`
- Test: `internal/mcp/tools_terminal_test.go`

**Step 1: Write the failing ANSI-strip test.**

Create `internal/mcp/ansi_test.go`:

```go
package mcp

import "testing"

func TestStripANSI(t *testing.T) {
	cases := []struct{ in, want string }{
		{"\x1b[31mred\x1b[0m", "red"},
		{"plain", "plain"},
		{"\x1b[2J\x1b[Hcleared", "cleared"},
		{"a\x1b[1;32mb\x1b[0mc", "abc"},
		{"\x1b]133;D;0\x07done", "done"}, // OSC sequence stripped
	}
	for _, tc := range cases {
		if got := StripANSI(tc.in); got != tc.want {
			t.Errorf("StripANSI(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
```

**Step 2: Run to verify it fails.**

Run: `go test ./internal/mcp/ -run StripANSI`
Expected: FAIL — `StripANSI` undefined.

**Step 3: Implement ANSI stripping.**

Create `internal/mcp/ansi.go`:

```go
package mcp

import "regexp"

// ansiCSI matches CSI escape sequences: ESC [ ... final-byte.
var ansiCSI = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

// ansiOSC matches OSC sequences: ESC ] ... terminated by BEL or ESC \.
var ansiOSC = regexp.MustCompile(`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)

// ansiOther matches stray single-char escapes like ESC ( B or ESC = .
var ansiOther = regexp.MustCompile(`\x1b[()#][0-9A-Za-z]|\x1b[=>78Mc]`)

// StripANSI removes common ANSI/VT escape sequences from s, leaving plain text.
// It handles CSI (colors, cursor moves, clears), OSC (titles, shell
// integration), and a few stray escapes. It is intentionally simple, not a
// full terminal emulator.
func StripANSI(s string) string {
	s = ansiOSC.ReplaceAllString(s, "")
	s = ansiCSI.ReplaceAllString(s, "")
	s = ansiOther.ReplaceAllString(s, "")
	return s
}
```

**Step 4: Run to verify ANSI test passes.**

Run: `go test ./internal/mcp/ -run StripANSI`
Expected: PASS.

**Step 5: Write the failing terminal-tools test.**

Create `internal/mcp/tools_terminal_test.go`. These tests register the terminal tools against a live sessiond + MCP client and invoke the handlers directly (the handler functions are what `tools/call` would dispatch to):

```go
package mcp

import (
	"strings"
	"testing"
)

func TestRunCommandReturnsOutput(t *testing.T) {
	socketPath := startSessiond(t)
	c, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer c.Close()
	wsID, _ := c.conn.CreateWorkspace("ws")
	if err := c.AttachWorkspace(wsID); err != nil {
		t.Fatalf("attach: %v", err)
	}
	paneID, err := c.conn.CreatePane(nil)
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	tools := newTerminalTools(c)
	out, err := tools.runCommand(map[string]any{
		"pane_id": float64(paneID), // JSON numbers decode as float64
		"command": "echo mcp_marker",
	})
	if err != nil {
		t.Fatalf("runCommand: %v", err)
	}
	if !strings.Contains(out, "mcp_marker") {
		t.Errorf("output missing marker: %q", out)
	}
}

func TestSendInputReturnsOK(t *testing.T) {
	socketPath := startSessiond(t)
	c, _ := DialSocket(socketPath)
	defer c.Close()
	wsID, _ := c.conn.CreateWorkspace("ws")
	_ = c.AttachWorkspace(wsID)
	paneID, _ := c.conn.CreatePane(nil)

	tools := newTerminalTools(c)
	out, err := tools.sendInput(map[string]any{
		"pane_id": float64(paneID),
		"text":    "ls\n",
	})
	if err != nil {
		t.Fatalf("sendInput: %v", err)
	}
	if !strings.Contains(out, "true") {
		t.Errorf("sendInput result = %q", out)
	}
}

func TestGetScreenReturnsText(t *testing.T) {
	socketPath := startSessiond(t)
	c, _ := DialSocket(socketPath)
	defer c.Close()
	wsID, _ := c.conn.CreateWorkspace("ws")
	_ = c.AttachWorkspace(wsID)
	paneID, _ := c.conn.CreatePane(nil)

	tools := newTerminalTools(c)
	out, err := tools.getScreen(map[string]any{"pane_id": float64(paneID)})
	if err != nil {
		t.Fatalf("getScreen: %v", err)
	}
	if !strings.Contains(out, "cursor") {
		t.Errorf("getScreen result missing cursor field: %q", out)
	}
}
```

**Step 6: Run to verify it fails.**

Run: `go test ./internal/mcp/ -run 'RunCommand|SendInput|GetScreen'`
Expected: FAIL — `newTerminalTools` undefined.

**Step 7: Implement the terminal tools.**

Create `internal/mcp/tools_terminal.go`:

```go
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// terminalTools groups the terminal-pane MCP tools over an MCP Client.
type terminalTools struct{ c *Client }

func newTerminalTools(c *Client) *terminalTools { return &terminalTools{c: c} }

// argInt extracts an integer argument. JSON numbers decode to float64.
func argInt(args map[string]any, key string) (int, error) {
	v, ok := args[key]
	if !ok {
		return 0, fmt.Errorf("missing required argument %q", key)
	}
	switch n := v.(type) {
	case float64:
		return int(n), nil
	case int:
		return n, nil
	default:
		return 0, fmt.Errorf("argument %q must be a number", key)
	}
}

func argString(args map[string]any, key string) (string, error) {
	v, ok := args[key]
	if !ok {
		return "", fmt.Errorf("missing required argument %q", key)
	}
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("argument %q must be a string", key)
	}
	return s, nil
}

// runCommand sends command + newline to the pane, waits for the OSC 133
// shell-prompt completion marker (with timeout), and returns the ANSI-stripped
// output plus exit code as JSON text.
func (t *terminalTools) runCommand(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	command, err := argString(args, "command")
	if err != nil {
		return "", err
	}
	timeoutMS := 30000
	if v, ok := args["timeout_ms"]; ok {
		if n, ok := v.(float64); ok {
			timeoutMS = int(n)
		}
	}

	t.c.ClearOutput(paneID)
	t.c.ArmPrompt(paneID)
	if err := t.c.conn.Input(uint32(paneID), []byte(command+"\n")); err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()
	exitCode, waitErr := t.c.WaitForPrompt(ctx, paneID)

	output := StripANSI(string(t.c.OutputBuffer(paneID)))
	if waitErr != nil {
		// Timeout (or cancel): return what we have with a sentinel exit code.
		exitCode = -1
	}
	return jsonText(map[string]any{"output": output, "exit_code": exitCode}), nil
}

// sendInput forwards raw text to the pane without waiting for completion.
func (t *terminalTools) sendInput(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	text, err := argString(args, "text")
	if err != nil {
		return "", err
	}
	if err := t.c.conn.Input(uint32(paneID), []byte(text)); err != nil {
		return "", err
	}
	return jsonText(map[string]any{"ok": true}), nil
}

// getScreen returns the current VT grid text and cursor for the pane.
func (t *terminalTools) getScreen(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	snap, err := t.c.conn.ScreenSnapshot(paneID)
	if err != nil {
		return "", err
	}
	cursor := map[string]any{"row": 0, "col": 0}
	if snap.Cursor != nil {
		cursor = map[string]any{"row": snap.Cursor.Row, "col": snap.Cursor.Col}
	}
	return jsonText(map[string]any{"text": snap.Text, "cursor": cursor}), nil
}

// jsonText marshals v to compact JSON for an MCP text content block. Marshal
// of a plain map never fails, so the error is dropped.
func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// registerTerminalTools wires the terminal tools onto the MCP server.
func registerTerminalTools(srv *Server, c *Client) {
	t := newTerminalTools(c)
	srv.Register("run_command",
		"Run a command in a terminal pane and wait for it to complete. Returns the full output and exit code. Uses OSC 133 shell integration for reliable completion detection. For long-running commands use send_input instead.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id":    map[string]any{"type": "integer"},
				"command":    map[string]any{"type": "string"},
				"timeout_ms": map[string]any{"type": "integer"},
			},
			"required": []any{"pane_id", "command"},
		},
		t.runCommand)
	srv.Register("send_input",
		"Send raw input to a terminal pane without waiting for completion. Use for interactive programs, control sequences (Ctrl-C, arrow keys), or commands where you want to manage the read loop yourself.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id": map[string]any{"type": "integer"},
				"text":    map[string]any{"type": "string"},
			},
			"required": []any{"pane_id", "text"},
		},
		t.sendInput)
	srv.Register("get_screen",
		"Get the current screen state of a terminal pane as plain text. Returns the visible VT grid content and cursor position.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id": map[string]any{"type": "integer"},
			},
			"required": []any{"pane_id"},
		},
		t.getScreen)
}
```

> `run_command` relies on the shell emitting an OSC 133 `;D` marker on completion. If a pane's shell lacks shell-integration, the call falls back to the `timeout_ms` path and returns `exit_code: -1` with whatever output accumulated — a documented, accepted limitation for Phase 4.

**Step 8: Run the terminal-tools tests.**

Run: `go test ./internal/mcp/...`
Expected: PASS. If `TestRunCommandReturnsOutput` is flaky because the default shell does not emit OSC 133, switch its `CreatePane(nil)` to an explicit shell-integration-emitting command, or assert on the timeout fallback output containing the marker. Do NOT weaken the assertion to always-pass.

**Step 9: Build gate.**

Run: `go build ./...`
Expected: success.

**Step 10: Commit.**

```
git add internal/mcp/ansi.go internal/mcp/ansi_test.go internal/mcp/tools_terminal.go internal/mcp/tools_terminal_test.go && git commit -m "feat: add MCP terminal tools (run_command, send_input, get_screen)"
```

---

## Task 4: Workspace tools

**Files:**
- Create: `internal/mcp/tools_workspace.go`
- Test: `internal/mcp/tools_workspace_test.go`

**Step 1: Write the failing test.**

Create `internal/mcp/tools_workspace_test.go`:

```go
package mcp

import (
	"strings"
	"testing"
)

func TestListAndCreateWorkspace(t *testing.T) {
	socketPath := startSessiond(t)
	c, _ := DialSocket(socketPath)
	defer c.Close()

	w := newWorkspaceTools(c)

	created, err := w.createWorkspace(map[string]any{"name": "alpha"})
	if err != nil {
		t.Fatalf("createWorkspace: %v", err)
	}
	if !strings.Contains(created, "workspace_id") {
		t.Errorf("createWorkspace result = %q", created)
	}

	list, err := w.listWorkspaces(map[string]any{})
	if err != nil {
		t.Fatalf("listWorkspaces: %v", err)
	}
	if !strings.Contains(list, "alpha") {
		t.Errorf("list missing created workspace: %q", list)
	}
}

func TestSwitchAndCloseWorkspace(t *testing.T) {
	socketPath := startSessiond(t)
	c, _ := DialSocket(socketPath)
	defer c.Close()

	id1, _ := c.conn.CreateWorkspace("one")
	id2, _ := c.conn.CreateWorkspace("two")
	if err := c.AttachWorkspace(id1); err != nil {
		t.Fatalf("attach: %v", err)
	}

	w := newWorkspaceTools(c)
	if _, err := w.switchWorkspace(map[string]any{"workspace_id": id2}); err != nil {
		t.Fatalf("switchWorkspace: %v", err)
	}
	if c.Workspace() != id2 {
		t.Errorf("workspace = %q, want %q", c.Workspace(), id2)
	}

	if _, err := w.closeWorkspace(map[string]any{"workspace_id": id1}); err != nil {
		t.Fatalf("closeWorkspace: %v", err)
	}
}
```

**Step 2: Run to verify it fails.**

Run: `go test ./internal/mcp/ -run Workspace`
Expected: FAIL — `newWorkspaceTools` undefined.

**Step 3: Implement the workspace tools.**

Create `internal/mcp/tools_workspace.go`:

```go
package mcp

// workspaceTools groups the workspace-management MCP tools.
type workspaceTools struct{ c *Client }

func newWorkspaceTools(c *Client) *workspaceTools { return &workspaceTools{c: c} }

// listWorkspaces returns all workspaces as a JSON array of
// {id, name, pane_count, active}.
func (w *workspaceTools) listWorkspaces(_ map[string]any) (string, error) {
	wss, err := w.c.conn.ListWorkspaces()
	if err != nil {
		return "", err
	}
	active := w.c.Workspace()
	out := make([]map[string]any, 0, len(wss))
	for _, ws := range wss {
		out = append(out, map[string]any{
			"id":         ws.WorkspaceID,
			"name":       ws.Name,
			"pane_count": ws.PaneCount,
			"active":     ws.WorkspaceID == active,
		})
	}
	return jsonText(out), nil
}

// createWorkspace creates a named workspace and returns its id.
func (w *workspaceTools) createWorkspace(args map[string]any) (string, error) {
	name, err := argString(args, "name")
	if err != nil {
		return "", err
	}
	id, err := w.c.conn.CreateWorkspace(name)
	if err != nil {
		return "", err
	}
	return jsonText(map[string]any{"workspace_id": id}), nil
}

// switchWorkspace detaches from the current workspace (implicitly, by
// attaching elsewhere) and attaches to workspace_id.
func (w *workspaceTools) switchWorkspace(args map[string]any) (string, error) {
	id, err := argString(args, "workspace_id")
	if err != nil {
		return "", err
	}
	if err := w.c.AttachWorkspace(id); err != nil {
		return "", err
	}
	return jsonText(map[string]any{"ok": true}), nil
}

// closeWorkspace closes workspace_id, killing its panes.
func (w *workspaceTools) closeWorkspace(args map[string]any) (string, error) {
	id, err := argString(args, "workspace_id")
	if err != nil {
		return "", err
	}
	if err := w.c.conn.CloseWorkspace(id); err != nil {
		return "", err
	}
	return jsonText(map[string]any{"ok": true}), nil
}

// registerWorkspaceTools wires the workspace tools onto the MCP server.
func registerWorkspaceTools(srv *Server, c *Client) {
	w := newWorkspaceTools(c)
	srv.Register("list_workspaces",
		"List all workspaces with their id, name, pane count, and whether the MCP session is currently attached to it.",
		map[string]any{"type": "object", "properties": map[string]any{}},
		w.listWorkspaces)
	srv.Register("create_workspace",
		"Create a new empty workspace with the given name and return its workspace id.",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{"name": map[string]any{"type": "string"}},
			"required":   []any{"name"},
		},
		w.createWorkspace)
	srv.Register("switch_workspace",
		"Switch the MCP session to a different workspace: detach from the current one and attach to the given workspace id. Subsequent terminal and layout tools target the new workspace.",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{"workspace_id": map[string]any{"type": "string"}},
			"required":   []any{"workspace_id"},
		},
		w.switchWorkspace)
	srv.Register("close_workspace",
		"Close a workspace by id, terminating all of its panes. This cannot be undone.",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{"workspace_id": map[string]any{"type": "string"}},
			"required":   []any{"workspace_id"},
		},
		w.closeWorkspace)
}
```

**Step 4: Run the workspace-tools tests.**

Run: `go test ./internal/mcp/...`
Expected: PASS.

**Step 5: Build gate.**

Run: `go build ./...`
Expected: success.

**Step 6: Commit.**

```
git add internal/mcp/tools_workspace.go internal/mcp/tools_workspace_test.go && git commit -m "feat: add MCP workspace tools (list/create/switch/close)"
```

---

## Task 5: Layout tools

> ⚠️ **Verify placement plumbing before coding `create_pane`.** Read `internal/sessiond/server.go`'s control dispatch (the `case Type...` block) to confirm how the daemon accepts a `create-pane` and whether placement (`split-right`, etc.) is expressed via a `TypeLayoutCommand` broadcast. The `sessiond.Client` exposes `CreatePane([]string)` and `CreateBrowserPane(...)`, both returning a pane id, but it does **NOT** expose a method to emit a `TypeLayoutCommand`. For Phase 4, `create_pane` creates the pane and records the requested `placement` in its JSON result; **actually executing the split is a browser-side dockview operation driven by the layout-command broadcast and is out of scope for the MCP server's own plumbing.** If you find a clean existing path to emit the layout-command, use it; otherwise return `{pane_id, placement}` and note placement is advisory. Do not invent new daemon protocol in this phase.

**Files:**
- Create: `internal/mcp/tools_layout.go`
- Test: `internal/mcp/tools_layout_test.go`

**Step 1: Write the failing test.**

Create `internal/mcp/tools_layout_test.go`:

```go
package mcp

import (
	"strings"
	"testing"
)

func TestCreateAndClosePane(t *testing.T) {
	socketPath := startSessiond(t)
	c, _ := DialSocket(socketPath)
	defer c.Close()
	wsID, _ := c.conn.CreateWorkspace("ws")
	if err := c.AttachWorkspace(wsID); err != nil {
		t.Fatalf("attach: %v", err)
	}

	l := newLayoutTools(c)
	out, err := l.createPane(map[string]any{"kind": "terminal"})
	if err != nil {
		t.Fatalf("createPane: %v", err)
	}
	if !strings.Contains(out, "pane_id") {
		t.Errorf("createPane result = %q", out)
	}
}

func TestGetLayoutReturnsASCII(t *testing.T) {
	socketPath := startSessiond(t)
	c, _ := DialSocket(socketPath)
	defer c.Close()
	wsID, _ := c.conn.CreateWorkspace("ws")
	if err := c.AttachWorkspace(wsID); err != nil {
		t.Fatalf("attach: %v", err)
	}
	if _, err := c.conn.CreatePane(nil); err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	l := newLayoutTools(c)
	out, err := l.getLayout(map[string]any{})
	if err != nil {
		t.Fatalf("getLayout: %v", err)
	}
	if out == "" {
		t.Errorf("getLayout returned empty diagram")
	}
}

func TestRenamePane(t *testing.T) {
	socketPath := startSessiond(t)
	c, _ := DialSocket(socketPath)
	defer c.Close()
	wsID, _ := c.conn.CreateWorkspace("ws")
	_ = c.AttachWorkspace(wsID)
	paneID, _ := c.conn.CreatePane(nil)

	l := newLayoutTools(c)
	out, err := l.renamePane(map[string]any{"pane_id": float64(paneID), "name": "build"})
	if err != nil {
		t.Fatalf("renamePane: %v", err)
	}
	if !strings.Contains(out, "true") {
		t.Errorf("renamePane result = %q", out)
	}
}
```

**Step 2: Run to verify it fails.**

Run: `go test ./internal/mcp/ -run 'Pane|Layout'`
Expected: FAIL — `newLayoutTools` undefined.

**Step 3: Implement the layout tools.**

Create `internal/mcp/tools_layout.go`:

```go
package mcp

import "fmt"

// layoutTools groups the pane-layout MCP tools.
type layoutTools struct{ c *Client }

func newLayoutTools(c *Client) *layoutTools { return &layoutTools{c: c} }

// createPane creates a terminal or browser pane in the attached workspace and
// returns its id. The placement field is advisory in Phase 4 (the browser
// executes the dockview split via a layout-command broadcast).
func (l *layoutTools) createPane(args map[string]any) (string, error) {
	kind, _ := args["kind"].(string)
	if kind == "" {
		kind = "terminal"
	}
	placement, _ := args["placement"].(string)

	var paneID int
	var err error
	switch kind {
	case "terminal":
		paneID, err = l.c.conn.CreatePane(nil)
	case "browser":
		port := 0
		if v, ok := args["browser_port"].(float64); ok {
			port = int(v)
		}
		url, _ := args["url"].(string)
		paneID, err = l.c.conn.CreateBrowserPane(port, url, nil)
	default:
		return "", fmt.Errorf("unknown pane kind %q (want \"terminal\" or \"browser\")", kind)
	}
	if err != nil {
		return "", err
	}
	res := map[string]any{"pane_id": paneID}
	if placement != "" {
		res["placement"] = placement
	}
	return jsonText(res), nil
}

// renamePane sets a pane's display name.
func (l *layoutTools) renamePane(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	name, err := argString(args, "name")
	if err != nil {
		return "", err
	}
	if err := l.c.conn.RenamePane(paneID, name); err != nil {
		return "", err
	}
	return jsonText(map[string]any{"ok": true}), nil
}

// closePane kills a pane in the attached workspace.
func (l *layoutTools) closePane(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	if err := l.c.conn.ClosePane(paneID); err != nil {
		return "", err
	}
	return jsonText(map[string]any{"ok": true}), nil
}

// listPanes returns the panes in the attached workspace as
// [{pane_id, kind, name}]. The composition snapshot from Attach is the source.
func (l *layoutTools) listPanes(args map[string]any) (string, error) {
	ws := l.c.Workspace()
	if id, ok := args["workspace"].(string); ok && id != "" {
		ws = id
	}
	if ws == "" {
		return "", fmt.Errorf("not attached to a workspace")
	}
	comp, err := l.c.conn.Attach(ws, "wide")
	if err != nil {
		return "", err
	}
	out := make([]map[string]any, 0, len(comp.Panes))
	for _, p := range comp.Panes {
		kind := p.SurfaceKind
		if kind == "" {
			kind = "terminal"
		}
		entry := map[string]any{"pane_id": p.PaneID, "kind": kind, "name": p.Title}
		if kind == "browser" {
			entry["hint"] = p.BrowserPath
		}
		out = append(out, entry)
	}
	return jsonText(out), nil
}

// getLayout returns the workspace's ASCII layout diagram as MCP text.
func (l *layoutTools) getLayout(_ map[string]any) (string, error) {
	return l.c.conn.GetLayout()
}

// registerLayoutTools wires the layout tools onto the MCP server.
func registerLayoutTools(srv *Server, c *Client) {
	l := newLayoutTools(c)
	srv.Register("create_pane",
		"Create a new pane in the current workspace. kind is \"terminal\" or \"browser\". placement is one of tab|split-right|split-left|split-above|split-below (advisory: the split is executed by the browser). For browser panes, provide url and browser_port. Browser automation tools land in Phase 5 (see playwright-cli).",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"kind":           map[string]any{"type": "string", "enum": []any{"terminal", "browser"}},
				"placement":      map[string]any{"type": "string", "enum": []any{"tab", "split-right", "split-left", "split-above", "split-below"}},
				"reference_pane": map[string]any{"type": "integer"},
				"url":            map[string]any{"type": "string"},
				"browser_port":   map[string]any{"type": "integer"},
			},
		},
		l.createPane)
	srv.Register("rename_pane",
		"Rename a pane's display title.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id": map[string]any{"type": "integer"},
				"name":    map[string]any{"type": "string"},
			},
			"required": []any{"pane_id", "name"},
		},
		l.renamePane)
	srv.Register("close_pane",
		"Close a pane by id, terminating its process.",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{"pane_id": map[string]any{"type": "integer"}},
			"required":   []any{"pane_id"},
		},
		l.closePane)
	srv.Register("list_panes",
		"List the panes in the current (or given) workspace with id, kind, name, and a hint (browser URL for browser panes).",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{"workspace": map[string]any{"type": "string"}},
		},
		l.listPanes)
	srv.Register("get_layout",
		"Get an ASCII diagram of the current workspace's pane layout (splits and tabs).",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{"workspace": map[string]any{"type": "string"}},
		},
		l.getLayout)
}
```

**Step 4: Run the layout-tools tests.**

Run: `go test ./internal/mcp/...`
Expected: PASS.

**Step 5: Build gate.**

Run: `go build ./...`
Expected: success.

**Step 6: Commit.**

```
git add internal/mcp/tools_layout.go internal/mcp/tools_layout_test.go && git commit -m "feat: add MCP layout tools (create/rename/close/list panes, get_layout)"
```

---

## Task 6: `muxterm mcp` subcommand

Wire the server, client, and all tool registrations into the CLI. The server must answer `initialize` **before** connecting to sessiond, so the smoke test works without a running daemon — defer the `mcp.Dial()` until the first tool call, or dial lazily. The simplest correct approach: register tools whose handlers dial-on-first-use via a shared lazy connector.

**Files:**
- Modify: `cmd/muxterm/cli.go` (parse the `mcp` subcommand + flags)
- Modify: `cmd/muxterm/main.go` (dispatch + `runMCPCommand`, update usage/version)
- Create: `internal/mcp/run.go` (assembles server + lazy client + tool registration)
- Test: `cmd/muxterm/mcp_integration_test.go`

**Step 1: Add the lazy-connect assembler.**

Create `internal/mcp/run.go`:

```go
package mcp

import (
	"fmt"
	"sync"
)

// lazyClient dials sessiond on first use so the MCP server can answer
// initialize/tools-list before a daemon connection exists. The first tool call
// that needs the daemon triggers the dial; failures surface as tool errors.
type lazyClient struct {
	once sync.Once
	c    *Client
	err  error
}

func (l *lazyClient) get() (*Client, error) {
	l.once.Do(func() { l.c, l.err = Dial() })
	if l.err != nil {
		return nil, fmt.Errorf("connect to sessiond: %w", l.err)
	}
	return l.c, nil
}

// NewStdioServer builds an MCP server with every Phase 4 tool registered. The
// sessiond connection is established lazily on the first tool call. The
// returned closer releases the daemon connection if one was opened.
func NewStdioServer() (*Server, func() error) {
	srv := NewServer()
	lc := &lazyClient{}

	// Each tool group is registered with a thin adapter that resolves the
	// lazy client, then delegates. This keeps initialize/tools-list working
	// with no daemon present.
	registerWithLazy(srv, lc)

	closer := func() error {
		if lc.c != nil {
			return lc.c.Close()
		}
		return nil
	}
	return srv, closer
}

// registerWithLazy registers all tool groups, wrapping each handler so the
// sessiond client is resolved on demand.
func registerWithLazy(srv *Server, lc *lazyClient) {
	// Build a throwaway Client-less registration to capture tool metadata, then
	// re-wrap. Simpler: resolve the client eagerly inside each adapter.
	wrap := func(fn func(*Client, map[string]any) (string, error)) ToolFunc {
		return func(args map[string]any) (string, error) {
			c, err := lc.get()
			if err != nil {
				return "", err
			}
			return fn(c, args)
		}
	}
	registerAllTools(srv, wrap)
}
```

> **Design note for the implementer:** the cleanest implementation refactors the three `register*Tools(srv, c)` functions to share a single `registerAllTools(srv, wrap)` that takes a wrapper turning `func(*Client, args)` handlers into `ToolFunc`s. Adjust `tools_terminal.go`, `tools_workspace.go`, and `tools_layout.go` so their handler methods have the signature `func(c *Client, args map[string]any) (string, error)` (or keep methods and wrap `t.runCommand` via a closure that injects the resolved client). Pick the approach that keeps the existing Task 3–5 tests compiling; if you change handler signatures, update those tests in the same task. The key invariant: **`initialize` and `tools/list` must not require a daemon.**

**Step 2: Add the `mcp` subcommand to the CLI parser.**

In `cmd/muxterm/cli.go`, add a case to the `switch args[0]` block in `ParseArgs`:

```go
	case "mcp":
		return parseMCP(args[1:])
```

Add the `Transport` and `Port` fields to `Config` (near `BrowserPort`):

```go
	Transport string // mcp mode: "stdio" (default) or "sse"
	MCPPort   int    // mcp SSE transport port (Phase 5)
```

Add the parser function:

```go
func parseMCP(args []string) (Config, error) {
	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	transport := fs.String("transport", "stdio", "MCP transport: stdio (SSE arrives in Phase 5)")
	port := fs.Int("port", 9092, "SSE transport port (Phase 5)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm mcp [flags]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Run the muxterm MCP server so AI agents can drive terminals, workspaces, and layout.")
		fmt.Fprintln(os.Stdout, "Speaks JSON-RPC 2.0 over stdio. Connects to the local sessiond daemon.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Flags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	return Config{Mode: "mcp", Transport: *transport, MCPPort: *port}, nil
}
```

**Step 3: Add the dispatch + runner in `main.go`.**

In `main.go`'s `switch cfg.Mode`, add:

```go
	case "mcp":
		if err := runMCPCommand(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
```

Add the runner (note: imports `"github.com/user/muxterm/internal/mcp"` and `"log"` — `log` is already imported):

```go
// runMCPCommand runs the MCP server. Phase 4 supports only the stdio transport;
// SSE is Phase 5. The server answers initialize/tools-list immediately and
// dials sessiond lazily on the first tool call. All diagnostics go to stderr
// because stdout is the JSON-RPC transport.
func runMCPCommand(cfg Config) error {
	if cfg.Transport != "stdio" {
		return fmt.Errorf("transport %q not supported in this build (only stdio; SSE arrives in Phase 5)", cfg.Transport)
	}
	log.SetOutput(os.Stderr)
	srv, closer := mcp.NewStdioServer()
	defer closer() //nolint:errcheck
	log.Printf("muxterm mcp: stdio transport ready")
	return srv.Run()
}
```

**Step 4: Update usage and version.**

In `cli.go`'s `printUsage`, add a line in the command list:

```go
	fmt.Fprintln(w, "  muxterm mcp [flags]         Run the MCP server for AI agents (stdio)")
```

In `main.go`'s `version` case, append an MCP note:

```go
	case "version":
		fmt.Printf("muxterm %s (MCP: stdio)\n", version)
```

**Step 5: Write the integration test.**

Create `cmd/muxterm/mcp_integration_test.go`. It builds the binary and drives an `initialize` over stdin — no sessiond required:

```go
package main

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestMCPInitializeOverStdio(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "muxterm")
	build := exec.Command("go", "build", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}

	cmd := exec.Command(bin, "mcp")
	cmd.Stdin = strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}` + "\n",
	)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	// stderr (logs) is allowed and ignored.
	if err := cmd.Run(); err != nil {
		t.Fatalf("run mcp: %v", err)
	}

	line := strings.TrimSpace(stdout.String())
	if line == "" {
		t.Fatalf("no stdout from mcp server")
	}
	var resp struct {
		JSONRPC string `json:"jsonrpc"`
		ID      int    `json:"id"`
		Result  struct {
			ProtocolVersion string `json:"protocolVersion"`
			ServerInfo      struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	// Only the first line is the initialize reply; split in case logs leaked.
	first := strings.SplitN(line, "\n", 2)[0]
	if err := json.Unmarshal([]byte(first), &resp); err != nil {
		t.Fatalf("decode response %q: %v", first, err)
	}
	if resp.JSONRPC != "2.0" || resp.ID != 1 {
		t.Errorf("bad envelope: %+v", resp)
	}
	if resp.Result.ProtocolVersion != "2024-11-05" || resp.Result.ServerInfo.Name != "muxterm" {
		t.Errorf("bad initialize result: %+v", resp.Result)
	}
}
```

> Because the process reads stdin to EOF and we provide a single line then close stdin, `Run()` returns cleanly after processing. Logs go to stderr, so stdout holds only the JSON-RPC reply.

**Step 6: Run the integration test.**

Run: `go test ./cmd/muxterm/ -run MCPInitialize -v`
Expected: PASS.

**Step 7: Build gate + full test.**

Run: `go build ./... && go test ./internal/mcp/... ./cmd/muxterm/...`
Expected: success, all tests PASS.

**Step 8: Manual smoke test.**

```
go build -o bin/muxterm ./cmd/muxterm
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | ./bin/muxterm mcp
```
Expected: one line of JSON on stdout containing `"serverInfo":{"name":"muxterm"...}`. (Log lines may appear on stderr — that is correct.)

Also verify tools/list (still no daemon needed):
```
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | ./bin/muxterm mcp
```
Expected: two JSON lines; the second lists `run_command`, `send_input`, `get_screen`, `list_workspaces`, `create_workspace`, `switch_workspace`, `close_workspace`, `create_pane`, `rename_pane`, `close_pane`, `list_panes`, `get_layout` (12 tools).

**Step 9: Commit.**

```
git add internal/mcp/run.go cmd/muxterm/cli.go cmd/muxterm/main.go cmd/muxterm/mcp_integration_test.go && git commit -m "feat: add 'muxterm mcp' stdio subcommand wiring all Phase 4 tools"
```

> If Step 1's `registerAllTools` refactor touched the Task 3–5 tool files, include those in this commit (or commit them as a `refactor:` immediately before).

---

## Done criteria

- [ ] `internal/mcp/server.go` — JSON-RPC stdio server: initialize, initialized (no-op), ping, tools/list, tools/call, `-32601`/`-32700` errors. (Task 1)
- [ ] `internal/sessiond` — `Handlers.OnShellPrompt` + `TypeShellPrompt` dispatch; `Client.ScreenSnapshot` + `Client.GetLayout`. (Task 2A)
- [ ] `internal/mcp/client.go` — sessiond connection wrapper: lazy/explicit dial, `SetHandlers` + `go Run()`, output buffering, `ArmPrompt`/`WaitForPrompt`. (Task 2B)
- [ ] Terminal tools: `run_command` (OSC 133 wait + ANSI strip + timeout fallback), `send_input`, `get_screen`. (Task 3)
- [ ] Workspace tools: `list_workspaces`, `create_workspace`, `switch_workspace`, `close_workspace`. (Task 4)
- [ ] Layout tools: `create_pane`, `rename_pane`, `close_pane`, `list_panes`, `get_layout`. (Task 5)
- [ ] `muxterm mcp` subcommand: stdio transport, lazy sessiond dial, logs to stderr, usage + version updated. (Task 6)
- [ ] `go build ./...` clean; `go test ./internal/mcp/... ./internal/sessiond/... ./cmd/muxterm/...` all pass.
- [ ] Manual smoke test returns a valid initialize reply and a 12-tool tools/list with no daemon running.
- [ ] Each task committed with a conventional-commit message.

## Out of scope (Phase 5)

- SSE transport (`--transport sse`, `--port`) — the flags are parsed and rejected with a clear error in Phase 4.
- Browser automation tools (click/fill/press/eval/snapshot via the SW bridge) — descriptions reference playwright-cli but no browser tool is registered.
- Executing dockview split placement from the MCP side (placement is advisory in `create_pane`).
