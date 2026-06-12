// Package mcp implements a JSON-RPC 2.0 MCP server over stdio.
package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
)

// Protocol and server version constants.
const (
	protocolVersion = "2024-11-05"
	serverVersion   = "0.1.0"
)

// JSON-RPC 2.0 error codes.
const (
	codeParseError     = -32700
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternalError  = -32603
)

// ToolFunc is the function signature for MCP tool handlers.
type ToolFunc func(args map[string]any) (string, error)

// tool holds a registered tool's metadata and handler.
type tool struct {
	name        string
	description string
	schema      map[string]any
	fn          ToolFunc
}

// Server is the MCP JSON-RPC 2.0 server.
type Server struct {
	in    *bufio.Reader
	out   *json.Encoder
	tools map[string]*tool
	order []string // registration order for stable tools/list output

	outMu sync.Mutex // serializes all writes to out (responses + notifications)

	// Resource provider hooks. Both may be nil (resources disabled).
	resourceList func() []map[string]any
	resourceRead func(uri string) (string, error)

	// Subscription state.
	subsMu        sync.Mutex
	subscriptions map[string]bool
}

// NewServer constructs a Server wired to os.Stdin and os.Stdout.
// CRITICAL: never log to stdout; all logging must go to stderr.
func NewServer() *Server {
	return NewServerWithIO(os.Stdin, os.Stdout)
}

// NewServerWithIO constructs a Server with the provided reader and writer.
// Used by tests with bytes.Buffer.
func NewServerWithIO(in io.Reader, out io.Writer) *Server {
	return &Server{
		in:            bufio.NewReader(in),
		out:           json.NewEncoder(out),
		tools:         make(map[string]*tool),
		subscriptions: make(map[string]bool),
	}
}

// SetResourceProvider installs the list and read hooks for MCP resources.
// Either or both may be nil to disable resources.
func (s *Server) SetResourceProvider(
	list func() []map[string]any,
	read func(uri string) (string, error),
) {
	s.resourceList = list
	s.resourceRead = read
}

// Register adds or updates a tool. If the name is new, it is appended to the
// ordered list; re-registration overwrites the tool but keeps its list position.
func (s *Server) Register(name, description string, schema map[string]any, fn ToolFunc) {
	if _, exists := s.tools[name]; !exists {
		s.order = append(s.order, name)
	}
	s.tools[name] = &tool{
		name:        name,
		description: description,
		schema:      schema,
		fn:          fn,
	}
}

// Run reads newline-delimited JSON-RPC requests until EOF, dispatching each.
// Returns nil on clean io.EOF; otherwise returns the read error.
func (s *Server) Run() error {
	for {
		line, err := s.in.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				// Handle any remaining content before EOF.
				trimmed := strings.TrimSpace(line)
				if trimmed != "" {
					s.handleLine(trimmed)
				}
				return nil
			}
			return err
		}
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			s.handleLine(trimmed)
		}
	}
}

// rpcRequest is the JSON-RPC 2.0 request envelope.
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// rpcError is the JSON-RPC 2.0 error object.
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// rpcResponse is the JSON-RPC 2.0 response envelope.
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// isNotification returns true if the request has no ID (notification).
func isNotification(id json.RawMessage) bool {
	return len(id) == 0
}

// handleLine parses and dispatches a single JSON-RPC request line.
func (s *Server) handleLine(line string) {
	var req rpcRequest
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		s.writeError(nil, codeParseError, "parse error")
		return
	}

	notification := isNotification(req.ID)

	switch req.Method {
	case "initialize":
		s.handleInitialize(req.ID)

	case "notifications/initialized":
		// No-op, no response.

	case "ping":
		if !notification {
			s.writeResult(req.ID, map[string]any{})
		}

	case "tools/list":
		if !notification {
			s.handleToolsList(req.ID)
		}

	case "tools/call":
		if !notification {
			s.handleToolsCall(req.ID, req.Params)
		}

	case "resources/list":
		if !notification {
			s.handleResourcesList(req.ID)
		}

	case "resources/read":
		if !notification {
			s.handleResourcesRead(req.ID, req.Params)
		}

	case "resources/subscribe":
		if !notification {
			s.handleResourcesSubscribe(req.ID, req.Params)
		}

	case "resources/unsubscribe":
		if !notification {
			s.handleResourcesUnsubscribe(req.ID, req.Params)
		}

	default:
		if !notification {
			s.writeError(req.ID, codeMethodNotFound, fmt.Sprintf("method not found: %s", req.Method))
		}
	}
}

// handleInitialize responds to the 'initialize' method.
func (s *Server) handleInitialize(id json.RawMessage) {
	result := map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities": map[string]any{
			"tools":     map[string]any{},
			"resources": map[string]any{"subscribe": true},
		},
		"serverInfo": map[string]any{
			"name":    "muxterm",
			"version": serverVersion,
		},
	}
	s.writeResult(id, result)
}

// handleToolsList responds to the 'tools/list' method with all registered tools.
func (s *Server) handleToolsList(id json.RawMessage) {
	tools := make([]map[string]any, 0, len(s.order))
	for _, name := range s.order {
		t := s.tools[name]
		tools = append(tools, map[string]any{
			"name":        t.name,
			"description": t.description,
			"inputSchema": t.schema,
		})
	}
	s.writeResult(id, map[string]any{"tools": tools})
}

// handleToolsCall responds to the 'tools/call' method by dispatching to the named tool.
func (s *Server) handleToolsCall(id json.RawMessage, rawParams json.RawMessage) {
	var params struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(rawParams, &params); err != nil {
		s.writeError(id, codeInvalidParams, "invalid params")
		return
	}
	if params.Name == "" {
		s.writeError(id, codeInvalidParams, "invalid params: missing name")
		return
	}

	t, ok := s.tools[params.Name]
	if !ok {
		s.writeError(id, codeMethodNotFound, fmt.Sprintf("unknown tool: %s", params.Name))
		return
	}

	if params.Arguments == nil {
		params.Arguments = make(map[string]any)
	}

	text, err := t.fn(params.Arguments)
	if err != nil {
		s.writeError(id, codeInternalError, err.Error())
		return
	}

	result := map[string]any{
		"content": []map[string]any{
			{
				"type": "text",
				"text": text,
			},
		},
	}
	s.writeResult(id, result)
}

// handleResourcesList responds to 'resources/list' with all provider resources.
func (s *Server) handleResourcesList(id json.RawMessage) {
	var resources []map[string]any
	if s.resourceList != nil {
		resources = s.resourceList()
	}
	if resources == nil {
		resources = []map[string]any{}
	}
	s.writeResult(id, map[string]any{"resources": resources})
}

// handleResourcesRead responds to 'resources/read' with the content of the named resource.
func (s *Server) handleResourcesRead(id json.RawMessage, rawParams json.RawMessage) {
	var params struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(rawParams, &params); err != nil {
		s.writeError(id, codeInvalidParams, "invalid params")
		return
	}
	if params.URI == "" {
		s.writeError(id, codeInvalidParams, "invalid params: missing uri")
		return
	}
	if s.resourceRead == nil {
		s.writeError(id, codeInternalError, "resources not available")
		return
	}
	text, err := s.resourceRead(params.URI)
	if err != nil {
		s.writeError(id, codeInternalError, err.Error())
		return
	}
	s.writeResult(id, map[string]any{
		"contents": []map[string]any{
			{
				"uri":      params.URI,
				"mimeType": "text/plain",
				"text":     text,
			},
		},
	})
}

// handleResourcesSubscribe records the URI in the subscriptions map.
func (s *Server) handleResourcesSubscribe(id json.RawMessage, rawParams json.RawMessage) {
	var params struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(rawParams, &params); err != nil {
		s.writeError(id, codeInvalidParams, "invalid params")
		return
	}
	s.subsMu.Lock()
	s.subscriptions[params.URI] = true
	s.subsMu.Unlock()
	s.writeResult(id, map[string]any{})
}

// handleResourcesUnsubscribe removes the URI from the subscriptions map.
func (s *Server) handleResourcesUnsubscribe(id json.RawMessage, rawParams json.RawMessage) {
	var params struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(rawParams, &params); err != nil {
		s.writeError(id, codeInvalidParams, "invalid params")
		return
	}
	s.subsMu.Lock()
	delete(s.subscriptions, params.URI)
	s.subsMu.Unlock()
	s.writeResult(id, map[string]any{})
}

// NotifyResourceUpdated sends a notifications/resources/updated notification if
// uri is subscribed. Safe to call from any goroutine.
func (s *Server) NotifyResourceUpdated(uri string) {
	s.subsMu.Lock()
	subscribed := s.subscriptions[uri]
	s.subsMu.Unlock()
	if !subscribed {
		return
	}
	s.writeNotification("notifications/resources/updated", map[string]any{"uri": uri})
}

// writeNotification sends a JSON-RPC 2.0 notification (no id). outMu-guarded.
func (s *Server) writeNotification(method string, params any) {
	type notification struct {
		JSONRPC string `json:"jsonrpc"`
		Method  string `json:"method"`
		Params  any    `json:"params"`
	}
	notif := notification{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}
	s.outMu.Lock()
	defer s.outMu.Unlock()
	if err := s.out.Encode(notif); err != nil {
		fmt.Fprintf(os.Stderr, "mcp: write notification error: %v\n", err)
	}
}

// writeResult sends a JSON-RPC success response.
// json.Encoder.Encode appends a newline — do not add an additional one.
func (s *Server) writeResult(id json.RawMessage, result any) {
	s.outMu.Lock()
	defer s.outMu.Unlock()
	resp := rpcResponse{
		JSONRPC: "2.0",
		ID:      nullIfEmpty(id),
		Result:  result,
	}
	// Errors writing to the transport are logged to stderr only.
	if err := s.out.Encode(resp); err != nil {
		fmt.Fprintf(os.Stderr, "mcp: write result error: %v\n", err)
	}
}

// writeError sends a JSON-RPC error response.
func (s *Server) writeError(id json.RawMessage, code int, message string) {
	s.outMu.Lock()
	defer s.outMu.Unlock()
	resp := rpcResponse{
		JSONRPC: "2.0",
		ID:      nullIfEmpty(id),
		Error:   &rpcError{Code: code, Message: message},
	}
	if err := s.out.Encode(resp); err != nil {
		fmt.Fprintf(os.Stderr, "mcp: write error error: %v\n", err)
	}
}

// nullIfEmpty returns the raw JSON message unchanged, or the JSON null literal
// if the message is empty (nil ID in a parse-error response).
func nullIfEmpty(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}
