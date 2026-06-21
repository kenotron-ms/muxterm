// Package sessiond defines the session daemon control protocol.
package sessiond

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

// Frame kinds tag each daemon socket frame. A frame is
// [4-byte BIG-ENDIAN length][1-byte kind][payload], where the length covers the
// kind byte plus the payload.
const (
	FrameControl     byte = 0x01 // payload is JSON of the Message envelope
	FramePaneData    byte = 0x02 // payload is [4-byte LITTLE-ENDIAN paneId][raw bytes]
	FrameBrowserData byte = 0x03 // payload is [4-byte LITTLE-ENDIAN paneId][raw JPEG bytes]
)

// Message Type strings name every frozen control envelope on the wire. No phase
// should hardcode a raw literal; reference these constants instead. The values
// are FROZEN per the v1 wire protocol contract (see
// docs/plans/2026-06-01-session-persistence-design.md) and must never change.
const (
	// Requests (client -> daemon).
	TypeCreateWorkspace = "create-workspace"
	TypeListWorkspaces  = "list-workspaces"
	TypeRenameWorkspace = "rename-workspace"
	TypeCloseWorkspace  = "close-workspace"
	TypeAttach          = "attach"
	TypeCreatePane      = "create-pane"
	TypeClosePane       = "close-pane"
	TypeResize          = "resize"
	TypeRenamePane      = "rename-pane"
	TypeSaveLayout      = "save-layout"
	TypeScreenSnapshot  = "screen-snapshot"  // request: MCP → daemon, VT grid for a pane
	TypeGetLayout       = "get-layout"       // request: MCP → daemon, ASCII layout diagram

	// Replies (daemon -> client, echo request cid).
	TypeWorkspaceCreated = "workspace-created"
	TypeWorkspaceList    = "workspace-list"
	TypeComposition      = "composition"
	TypePaneCreated      = "pane-created"
	TypeOK                    = "ok"
	TypeScreenSnapshotResult  = "screen-snapshot-result"
	TypeLayoutResult          = "layout-result"

	// Events (daemon -> all subscribers, cid=0).
	TypePaneAdded        = "pane-added"
	TypePaneClosed       = "pane-closed"
	TypeWorkspaceClosed  = "workspace-closed"
	TypeWorkspaceRenamed = "workspace-renamed"
	TypePaneRenamed      = "pane-renamed"
	TypeBrowserAction       = "browser-action"        // relay browser DOM command to/from SW bridge
	TypeBrowserActionResult = "browser-action-result" // relay browser DOM command result back to MCP client
	TypeLayoutCommand       = "layout-command"        // relay layout mutation to browser clients
	TypeShellPrompt         = "shell-prompt"          // OSC 133 prompt/command lifecycle

	// Error envelope.
	TypeError = "error"

	// Browser CDP pane messages (/ws/browser WebSocket).
	TypeCreateBrowserPane       = "create-browser-pane"
	TypeCloseBrowserPane        = "close-browser-pane"
	TypeBrowserInput            = "browser-input"
	TypeBrowserURL              = "browser-url"
	TypeBrowserDownloadProgress = "browser-download-progress"
	TypeBrowserError            = "browser-error"
	TypeBrowserFocus   = "browser-focus"   // client → sessiond: focus claim + viewport size
	TypeBrowserBlur    = "browser-blur"    // client → sessiond: focus release
	TypeBrowserGranted = "browser-granted" // sessiond → client: input authority notification

	// Tunnel messages (client ↔ serve, not forwarded to daemon).
	TypeCreateTunnel  = "create-tunnel"
	TypeCloseTunnel   = "close-tunnel"
	TypeListTunnels   = "list-tunnels"
	TypeTunnelCreated = "tunnel-created"
	TypeTunnelClosed  = "tunnel-closed"
	TypeTunnelList    = "tunnel-list"
)

// Error codes are the frozen Message.Code values carried by a TypeError
// envelope. FROZEN per the v1 wire protocol contract.
const (
	CodeUnknownWorkspace = "unknown-workspace"
	CodePaneSpawnFailed  = "pane-spawn-failed"
	CodePaneNotFound     = "pane-not-found"
)

// writeFrame writes a single framed message: a 5-byte header consisting of a
// big-endian uint32 length (kind byte + payload) followed by the kind byte,
// then the payload (if any).
func writeFrame(w io.Writer, kind byte, payload []byte) error {
	var hdr [5]byte
	binary.BigEndian.PutUint32(hdr[0:4], uint32(1+len(payload)))
	hdr[4] = kind
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := w.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

// WriteControl marshals msg to JSON and writes it as a FrameControl frame.
func WriteControl(w io.Writer, msg *Message) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return writeFrame(w, FrameControl, payload)
}

// WritePaneData writes a FramePaneData frame whose payload is
// [4-byte LITTLE-ENDIAN paneId][raw bytes]. Little-endian matches the existing
// browser framing so serve can bridge the body without rewriting it. The body
// is binary-safe (may contain newlines and NUL bytes).
func WritePaneData(w io.Writer, paneID uint32, data []byte) error {
	payload := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(payload[0:4], paneID)
	copy(payload[4:], data)
	return writeFrame(w, FramePaneData, payload)
}

// WriteBrowserData writes a FrameBrowserData frame whose payload is
// [4-byte LITTLE-ENDIAN paneId][raw JPEG bytes]. Same framing as WritePaneData
// but uses FrameBrowserData (0x03) so the HTTP server can distinguish JPEG frames
// from PTY output frames.
func WriteBrowserData(w io.Writer, paneID uint32, data []byte) error {
	payload := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(payload[0:4], paneID)
	copy(payload[4:], data)
	return writeFrame(w, FrameBrowserData, payload)
}

// DecodePaneData splits a FramePaneData payload into its little-endian paneID
// and raw body. A payload shorter than the 4-byte paneId header is malformed
// and yields (0, nil) defensively rather than panicking.
func DecodePaneData(payload []byte) (paneID uint32, data []byte) {
	if len(payload) < 4 {
		return 0, nil
	}
	return binary.LittleEndian.Uint32(payload[0:4]), payload[4:]
}

// ReadFrame reads one frame and returns its kind and payload. This is the
// frozen 3-value signature (kind, payload, err) and must not change shape.
func ReadFrame(r io.Reader) (kind byte, payload []byte, err error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	total := binary.BigEndian.Uint32(hdr[:])
	if total < 1 {
		return 0, nil, fmt.Errorf("sessiond: frame length %d too short (need >=1 for kind byte)", total)
	}
	buf := make([]byte, total)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return buf[0], buf[1:], nil
}

// Message is the single control envelope. Every request, reply, event, and
// error is this struct with a different Type. The JSON tags are FROZEN per the
// v1 wire protocol contract (see
// docs/plans/2026-06-01-session-persistence-design.md) and must never change.
type Message struct {
	Type        string          `json:"type"`
	CID         uint64          `json:"cid,omitempty"`         // request/reply correlation, 0 = unsolicited event
	ClientRef   string          `json:"clientRef,omitempty"`   // client-minted optimistic-create correlation id
	WorkspaceID string          `json:"workspaceId,omitempty"` //
	Name        string          `json:"name,omitempty"`        //
	PaneID      int             `json:"paneId,omitempty"`      // workspace-local
	Cols        int             `json:"cols,omitempty"`        //
	Rows        int             `json:"rows,omitempty"`        //
	Cmd         []string        `json:"cmd,omitempty"`         // argv, empty => default $SHELL
	Title       string          `json:"title,omitempty"`       //
	Breakpoint  string          `json:"breakpoint,omitempty"`  // responsive layout key (opaque to daemon)
	Layout      string          `json:"layout,omitempty"`      // opaque dockview layout JSON blob
	Workspaces  []WorkspaceInfo `json:"workspaces,omitempty"`  //
	Panes       []PaneInfo      `json:"panes,omitempty"`       //
	Code        string          `json:"code,omitempty"`        // error code
	Error       string          `json:"error,omitempty"`       // human-readable error text

	// Browser pane fields (used in create-pane and pane-added for browser surface kinds)
	SurfaceKind  string            `json:"surfaceKind,omitempty"`

	// Layout placement fields (create-pane request → pane-added broadcast → browser dockview)
	Placement      string `json:"placement,omitempty"`      // tab|split-right|split-left|split-above|split-below
	ReferencePaneID int   `json:"referencePaneId,omitempty"` // pane to split relative to; 0 = active pane

	// MCP relay fields (browser-action, screen-snapshot-result, shell-prompt, get-layout).
	Action     string     `json:"action,omitempty"`     // browser-action verb: click/fill/...
	Ref        string     `json:"ref,omitempty"`        // element ref e1,e2 from snapshot
	Selector   string     `json:"selector,omitempty"`   // CSS selector
	Value      string     `json:"value,omitempty"`      // input value for fill/type
	Key        string     `json:"key,omitempty"`        // keyboard key for press
	Expression string     `json:"expr,omitempty"`       // JS expression for eval
	Text       string     `json:"text,omitempty"`       // plain-text result: screen snapshot, eval
	ExitCode   int        `json:"exitCode,omitempty"`   // OSC 133 command exit code
	Cursor     *CursorPos `json:"cursor,omitempty"`     // cursor {row,col} for screen snapshot
	ASCII      string     `json:"ascii,omitempty"`      // ASCII layout diagram, get-layout result

	// Browser action result fields (browser-action-result event, shim → MCP round-trip).
	Snapshot string          `json:"snapshot,omitempty"` // accessibility tree YAML from browser_snapshot
	Result   json.RawMessage `json:"result,omitempty"`   // JS eval result (any JSON value)
	OK       bool            `json:"ok,omitempty"`       // true when action succeeded without error

	// Tunnel fields (create-tunnel, tunnel-created, close-tunnel, tunnel-list).
	TunnelID   string       `json:"tunnelId,omitempty"`
	TunnelPort int          `json:"tunnelPort,omitempty"`
	Tunnels    []TunnelInfo `json:"tunnels,omitempty"`

	// Browser relay fields (browser-focus, browser-blur, browser-input, browser-granted).
	ClientID         string          `json:"clientId,omitempty"`         // stable per /ws/browser connection
	DeviceID         string          `json:"deviceId,omitempty"`         // localStorage UUID, stable per physical machine
	RenderWidth      int             `json:"renderWidth,omitempty"`      // canvas CSS width in px at focus time
	RenderHeight     int             `json:"renderHeight,omitempty"`     // canvas CSS height in px at focus time
	DevicePixelRatio float64         `json:"devicePixelRatio,omitempty"` // client window.devicePixelRatio; 0 means 1.0
	InputEvent       json.RawMessage `json:"inputEvent,omitempty"`       // raw BrowserInputMsg JSON for browser-input
	RawPayload       json.RawMessage `json:"rawPayload,omitempty"`       // original JSON bytes for relay passthrough
}

// TunnelInfo is one entry in a tunnel-list reply.
type TunnelInfo struct {
	ID   string `json:"id"`
	Port int    `json:"port"`
}

// BrowserInputMsg is the event payload for {type:"browser-input"},
// {type:"browser-focus"}, and {type:"browser-blur"} JSON frames sent by the
// browser client on /ws/browser. The Type field names the input event (e.g.
// "click", "scroll", "keydown", "type", "navigate", "resize", "browser-focus",
// "browser-blur"). All geometry and value fields are optional; omit those not
// relevant to the event.
type BrowserInputMsg struct {
	Type   string  `json:"type"`
	X      float64 `json:"x,omitempty"`      // pointer X coordinate
	Y      float64 `json:"y,omitempty"`      // pointer Y coordinate
	Button  string `json:"button,omitempty"`  // left|middle|right
	Buttons int    `json:"buttons,omitempty"` // bitmask of currently-held buttons: 1=left,2=right,4=middle
	DeltaX float64 `json:"deltaX,omitempty"` // scroll delta X
	DeltaY float64 `json:"deltaY,omitempty"` // scroll delta Y
	Key       string  `json:"key,omitempty"`       // e.g. "Enter", "ArrowLeft", "a"
	Text      string  `json:"text,omitempty"`      // for "type" events
	URL       string  `json:"url,omitempty"`       // for "navigate" events; "history:back" etc.
	Width     int     `json:"width,omitempty"`     // for "resize" events
	Height    int     `json:"height,omitempty"`    // for "resize" events
	Modifiers int     `json:"modifiers,omitempty"` // CDP modifiers bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8

	ClientID     string `json:"clientId,omitempty"`     // stable per-connection ID (browser-focus/blur)
	DeviceID     string `json:"deviceId,omitempty"`     // stable per-device ID (browser-focus/blur)
	RenderWidth     int     `json:"renderWidth,omitempty"`     // canvas CSS width at focus time
	RenderHeight    int     `json:"renderHeight,omitempty"`    // canvas CSS height at focus time
	DevicePixelRatio float64 `json:"devicePixelRatio,omitempty"` // client window.devicePixelRatio; 0 means 1.0
}

// BrowserURLMsg is the {type:"browser-url"} frame sent by the server on
// /ws/browser when the headless browser navigates to a new URL.
type BrowserURLMsg struct {
	Type   string `json:"type"`
	PaneID int    `json:"paneId"`
	URL    string `json:"url"`
}

// BrowserProgressMsg is the {type:"browser-download-progress"} frame sent
// while Chromium is being downloaded. Percent is 0–100.
type BrowserProgressMsg struct {
	Type    string `json:"type"`
	PaneID  int    `json:"paneId"`
	Percent int    `json:"percent"`
}

// BrowserErrorMsg is the {type:"browser-error"} frame sent when a browser
// operation fails (download failure, navigation error, Chromium crash).
type BrowserErrorMsg struct {
	Type   string `json:"type"`
	PaneID int    `json:"paneId"`
	Error  string `json:"error"`
}

// BrowserGrantedMsg is the {type:"browser-granted"} frame sent to all /ws/browser
// clients when a client claims input authority via browser-focus.
type BrowserGrantedMsg struct {
	Type     string `json:"type"`
	PaneID   int    `json:"paneId"`
	ClientID string `json:"clientId"` // the client that now holds authority
}

// CursorPos is a 0-indexed terminal cursor position carried by screen-snapshot-result.
type CursorPos struct {
	Row int `json:"row"`
	Col int `json:"col"`
}

// WorkspaceInfo is one entry in a workspace-list reply.
type WorkspaceInfo struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name,omitempty"`
	ClientRef   string `json:"clientRef,omitempty"`
	PaneCount   int    `json:"paneCount"`
}

// PaneInfo is one entry in a composition reply or pane-added event.
type PaneInfo struct {
	PaneID      int    `json:"paneId"`
	SurfaceKind string `json:"surfaceKind,omitempty"` // "terminal" | "browser-cdp"; absent = "terminal"
	Cols        int    `json:"cols,omitempty"`
	Rows        int    `json:"rows,omitempty"`
	Title       string `json:"title,omitempty"`
	TotalSeq    uint64 `json:"totalSeq,omitempty"` // exact byte length of the replay data for this pane

	// Layout placement (only present on pane-added events from create-pane requests
	// that carried an explicit placement token; absent means default/tab placement).
	Placement       string `json:"placement,omitempty"`       // tab|split-right|split-left|split-above|split-below
	ReferencePaneID int    `json:"referencePaneId,omitempty"` // pane to split relative to; 0 = active pane
}
