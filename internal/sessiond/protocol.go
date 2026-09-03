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
	FrameControl  byte = 0x01 // payload is JSON of the Message envelope
	FramePaneData byte = 0x02 // payload is [4-byte LITTLE-ENDIAN paneId][raw bytes]
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
	TypePaneFocus       = "pane-focus"
	TypeRenamePane      = "rename-pane"
	TypeSaveLayout      = "save-layout"
	TypeScreenSnapshot  = "screen-snapshot" // request: MCP → daemon, VT grid for a pane
	TypeGetLayout       = "get-layout"      // request: MCP → daemon, ASCII layout diagram

	// Replies (daemon -> client, echo request cid).
	TypeWorkspaceCreated     = "workspace-created"
	TypeWorkspaceList        = "workspace-list"
	TypeComposition          = "composition"
	TypePaneCreated          = "pane-created"
	TypeOK                   = "ok"
	TypeScreenSnapshotResult = "screen-snapshot-result"
	TypeLayoutResult         = "layout-result"

	// Events (daemon -> all subscribers, cid=0).
	TypePaneAdded           = "pane-added"
	TypePaneClosed          = "pane-closed"
	TypeWorkspaceClosed     = "workspace-closed"
	TypeWorkspaceRenamed    = "workspace-renamed"
	TypePaneRenamed         = "pane-renamed"
	TypeBrowserAction       = "browser-action"        // relay browser DOM command to/from SW bridge
	TypeBrowserActionResult = "browser-action-result" // relay browser DOM command result back to MCP client
	TypeLayoutCommand       = "layout-command"        // relay layout mutation to browser clients
	TypeShellPrompt         = "shell-prompt"          // OSC 133 prompt/command lifecycle
	TypePaneResized         = "pane-resized"          // broadcast: canonical PTY size changed

	// Error envelope.
	TypeError = "error"

	// Client-driven browser pane messages (ride /ws; no server-side engine).
	// The daemon holds only a pane handle and RELAYS commands to the client that
	// owns the pane. See docs/muxterm-client-protocol.md.
	TypeCreateBrowserPane = "create-browser-pane" // client → daemon: allocate a browser pane handle
	TypeCloseBrowserPane  = "close-browser-pane"  // client → daemon: close a browser pane
	TypeBrowserCommand    = "browser-command"     // relayed to workspace subs: {paneId, cid, action, params}
	TypeBrowserResult     = "browser-result"      // relayed to workspace subs: {paneId, cid, result | error}
	TypeBrowserURL        = "browser-url"         // client -> server -> workspace subs: navigation committed
	TypeBrowserLoad       = "browser-load"        // client -> server -> workspace subs: page load complete
)

// Error codes are the frozen Message.Code values carried by a TypeError
// envelope. FROZEN per the v1 wire protocol contract.
const (
	CodeUnknownWorkspace = "unknown-workspace"
	CodePaneSpawnFailed  = "pane-spawn-failed"
	CodePaneNotFound     = "pane-not-found"
)

// Scrollback pagination message types (ADDITIVE, post-v1). These extend the
// frozen protocol above without altering any existing constant or field:
// TypeScrollbackPage is a client -> daemon request for one page of a pane's
// server-side scrollback history; TypeScrollbackPageResult is the daemon's
// reply, echoing the request cid. See
// docs/designs/2026-08-12-sessiond-cli-scrollback-design.md.
const (
	TypeScrollbackPage       = "scrollback-page"        // request:  client -> daemon
	TypeScrollbackPageResult = "scrollback-page-result" // reply:    daemon -> client
)

// Sidebar live-preview message types (ADDITIVE, post-v1). These extend the
// frozen protocol above without altering any existing constant or field. See
// docs/designs/2026-09-02-sidebar-live-preview-design.md.
//
// TypePreviewSubscribe is a per-connection opt-in: Message.OK true enables
// preview tiles for that connection, false disables them. The daemon
// acknowledges with TypePreviewSubscribeResult (OK true = "this daemon
// understands preview-subscribe and applied it"), which is how a new browser
// against an older daemon discovers the feature is absent.
//
// TypeWorkspacePreview is the daemon -> subscriber event carrying one
// monochrome text tile:
//
//	WorkspaceID, PaneID, Title, Cols, Rows, Lines
//
// Cols/Rows are the CANONICAL tile geometry (80x24), not the pane's real PTY
// size: one tile is rendered per workspace and each client crops it to its own
// sidebar width. Lines holds at most Rows entries of at most Cols characters
// each, trailing-space trimmed, bottom-anchored on content; the client re-pads
// and top-pads. It deliberately reuses the existing Lines field rather than
// minting a second string-slice field.
//
// Deliberately NOT named "pane-update": that string is declared in
// web/src/types.ts with no Go counterpart and is referenced by an existing test
// file. Reusing it would resurrect dead vocabulary.
const (
	TypePreviewSubscribe       = "preview-subscribe"        // request: client -> daemon
	TypePreviewSubscribeResult = "preview-subscribe-result" // reply:   daemon -> client
	TypeWorkspacePreview       = "workspace-preview"        // event:   daemon -> opted-in subscribers
)

// Activity-aware close message types are additive. They preserve the legacy
// force-close messages while routing browser close intents through daemon-owned
// activity and ticket authority.
const (
	TypeCloseIntent  = "close-intent"  // request: browser relay -> daemon
	TypeCloseConfirm = "close-confirm" // request: browser relay -> daemon
	TypeCloseOutcome = "close-outcome" // reply: daemon -> browser relay
)

// CloseRiskInfo is one user-safe activity warning in a close-outcome. It is
// deliberately a wire type rather than the daemon's internal CloseRisk so its
// JSON field names are fixed independently of internal transaction state.
type CloseRiskInfo struct {
	PaneID         int    `json:"paneId"`
	Title          string `json:"title"`
	Classification string `json:"classification"`
	Reason         string `json:"reason"`
}

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
	ClientKind  string          `json:"clientKind,omitempty"`  // "interactive" (browser/human) | "agent" (MCP/automation)
	Layout      string          `json:"layout,omitempty"`      // opaque dockview layout JSON blob
	Workspaces  []WorkspaceInfo `json:"workspaces,omitempty"`  //
	Panes       []PaneInfo      `json:"panes,omitempty"`       //
	Code        string          `json:"code,omitempty"`        // error code
	Error       string          `json:"error,omitempty"`       // human-readable error text

	// Activity-aware close fields (ADDITIVE). The pointer counts and risks
	// preserve required zero and empty values on confirmation-required outcomes
	// without adding these fields to unrelated messages.
	TargetKind       string           `json:"targetKind,omitempty"`       // "pane" | "workspace"
	CloseStatus      string           `json:"closeStatus,omitempty"`      // "closed" | "confirmation-required" | "failed"
	Ticket           string           `json:"ticket,omitempty"`           // opaque daemon-issued confirmation ticket
	BusyCount        *int             `json:"busyCount,omitempty"`        // present for confirmation-required, including zero
	UnknownCount     *int             `json:"unknownCount,omitempty"`     // present for confirmation-required, including zero
	Risks            *[]CloseRiskInfo `json:"risks,omitempty"`            // present for confirmation-required, including []
	OmittedRiskCount *int             `json:"omittedRiskCount,omitempty"` // present for confirmation-required, including zero
	FailureCode      string           `json:"failureCode,omitempty"`      // stable close failure category

	// Browser pane fields (used in create-pane and pane-added for browser surface kinds)
	SurfaceKind string `json:"surfaceKind,omitempty"`

	// Layout placement fields (create-pane request → pane-added broadcast → browser dockview)
	Placement       string `json:"placement,omitempty"`       // tab|split-right|split-left|split-above|split-below
	ReferencePaneID int    `json:"referencePaneId,omitempty"` // pane to split relative to; 0 = active pane

	// MCP relay fields (browser-action, screen-snapshot-result, shell-prompt, get-layout).
	Action     string     `json:"action,omitempty"`   // browser-action verb: click/fill/...
	Ref        string     `json:"ref,omitempty"`      // element ref e1,e2 from snapshot
	Selector   string     `json:"selector,omitempty"` // CSS selector
	Value      string     `json:"value,omitempty"`    // input value for fill/type
	Key        string     `json:"key,omitempty"`      // keyboard key for press
	Expression string     `json:"expr,omitempty"`     // JS expression for eval
	Text       string     `json:"text,omitempty"`     // plain-text result: screen snapshot, eval
	ExitCode   int        `json:"exitCode,omitempty"` // OSC 133 command exit code
	Cursor     *CursorPos `json:"cursor,omitempty"`   // cursor {row,col} for screen snapshot
	ASCII      string     `json:"ascii,omitempty"`    // ASCII layout diagram, get-layout result

	// Real process exit fields (pane-closed only, process-exit-driven close).
	// ProcessExitCode is a pointer so 0 (a normal successful exit) is
	// distinguishable from "field absent" (e.g. a client-requested close,
	// which has no real process exit code).
	ProcessExitCode *int  `json:"processExitCode,omitempty"` // real shell process exit code, set on pane-closed only
	RuntimeMs       int64 `json:"runtimeMs,omitempty"`       // real shell process wall-clock runtime, set on pane-closed only

	// Params carries the browser-command parameters as raw JSON for passthrough
	// relay (TypeBrowserCommand). Schema (see docs/muxterm-client-protocol.md):
	//   { "action": "navigate|click|scroll|evaluate|back|forward|reload",
	//     "selector"?: string,        // CSS selector — element targeting
	//     "x"?: number, "y"?: number, // CSS px — coordinate targeting
	//     "url"?: string,             // for navigate
	//     "script"?: string,          // for evaluate
	//     "timeoutMs"?: number }      // evaluate timeout; default 30000, bounded
	// An action carries EXACTLY ONE of {selector} or {x,y}. evaluate is governed
	// by a bounded timeout (default 30s) so an injected script cannot hang the pane.
	Params json.RawMessage `json:"params,omitempty"`

	// Browser action result fields (browser-action-result event, shim → MCP round-trip).
	Snapshot string          `json:"snapshot,omitempty"` // accessibility tree YAML from browser_snapshot
	Result   json.RawMessage `json:"result,omitempty"`   // JS eval result (any JSON value)
	OK       bool            `json:"ok,omitempty"`       // true when action succeeded without error

	// URL carries the committed/loaded URL for TypeBrowserURL and TypeBrowserLoad
	// client-to-server browser pane navigation notifications.
	URL string `json:"url,omitempty"`

	// Scrollback pagination fields (ADDITIVE, post-v1; see TypeScrollbackPage).
	// LineCursor is deliberately NOT named "Cursor": Message.Cursor is the
	// frozen *CursorPos screen-snapshot field above and cannot be reused.
	//
	//   Request  (TypeScrollbackPage):       PaneID, LineCursor, Limit
	//   Reply    (TypeScrollbackPageResult): PaneID, Lines, NextCursor, StartLine
	//
	// LineCursor is an EXCLUSIVE upper bound expressed as an absolute
	// line-sequence number: the page returned is the (up to) Limit lines
	// immediately BEFORE it. Nil/omitted means "start just before the current
	// live viewport", i.e. the most recent page of history. NextCursor is the
	// value to send as the next request's LineCursor to page further back; nil
	// means no more retained history in that direction (the normal termination
	// condition for a paging loop). StartLine is the absolute sequence of the
	// first returned line, which reveals when a request was clamped to the
	// oldest retained line.
	//
	// Lines is additionally the tile payload of TypeWorkspacePreview (one
	// entry per rendered terminal row); the two uses never appear on the same
	// message, so no second string-slice field is minted for it.
	LineCursor *uint64  `json:"lineCursor,omitempty"`
	Limit      int      `json:"limit,omitempty"`
	Lines      []string `json:"lines,omitempty"`
	NextCursor *uint64  `json:"nextCursor,omitempty"`
	StartLine  uint64   `json:"startLine,omitempty"`
}

// CloseOutcomeMessage maps a daemon close transaction result onto the additive
// wire envelope. cid belongs to the caller's current transport domain: the
// daemon server uses its socket cid, while the browser relay supplies the
// initiating browser cid after its independent daemon request completes.
func CloseOutcomeMessage(cid uint64, outcome CloseOutcome) *Message {
	msg := &Message{
		Type:        TypeCloseOutcome,
		CID:         cid,
		TargetKind:  string(outcome.TargetKind),
		WorkspaceID: outcome.WorkspaceID,
		PaneID:      outcome.PaneID,
		CloseStatus: string(outcome.Status),
	}

	switch outcome.Status {
	case CloseStatusConfirmationRequired:
		busyCount := outcome.BusyCount
		unknownCount := outcome.UnknownCount
		omittedRiskCount := outcome.OmittedRiskCount
		risks := make([]CloseRiskInfo, len(outcome.Risks))
		for i, risk := range outcome.Risks {
			risks[i] = CloseRiskInfo{
				PaneID:         risk.PaneID,
				Title:          risk.Title,
				Classification: string(risk.Classification),
				Reason:         string(risk.Reason),
			}
		}
		msg.Ticket = outcome.Ticket
		msg.BusyCount = &busyCount
		msg.UnknownCount = &unknownCount
		msg.Risks = &risks
		msg.OmittedRiskCount = &omittedRiskCount
	case CloseStatusFailed:
		msg.FailureCode = outcome.FailureCode
		msg.Error = outcome.Error
	}

	return msg
}

// ParseCloseOutcomeMessage decodes the additive close-outcome envelope into the
// daemon transaction shape. It rejects malformed outcomes so a relay never
// grants destructive authority based on an incomplete daemon reply.
func ParseCloseOutcomeMessage(msg *Message) (CloseOutcome, error) {
	if msg == nil || msg.Type != TypeCloseOutcome {
		return CloseOutcome{}, fmt.Errorf("sessiond: expected %q reply", TypeCloseOutcome)
	}

	target := CloseTarget{
		Kind:        CloseTargetKind(msg.TargetKind),
		WorkspaceID: msg.WorkspaceID,
		PaneID:      msg.PaneID,
	}
	outcome := CloseOutcome{
		Status:      CloseStatus(msg.CloseStatus),
		TargetKind:  target.Kind,
		WorkspaceID: target.WorkspaceID,
		PaneID:      target.PaneID,
		Ticket:      msg.Ticket,
		FailureCode: msg.FailureCode,
		Error:       msg.Error,
	}

	switch outcome.Status {
	case CloseStatusClosed:
		if !target.valid() {
			return CloseOutcome{}, fmt.Errorf("sessiond: closed close outcome has invalid target")
		}
	case CloseStatusConfirmationRequired:
		if !target.valid() || outcome.Ticket == "" ||
			msg.BusyCount == nil || msg.UnknownCount == nil ||
			msg.Risks == nil || msg.OmittedRiskCount == nil {
			return CloseOutcome{}, fmt.Errorf("sessiond: confirmation-required close outcome is incomplete")
		}
		outcome.BusyCount = *msg.BusyCount
		outcome.UnknownCount = *msg.UnknownCount
		outcome.OmittedRiskCount = *msg.OmittedRiskCount
		outcome.Risks = make([]CloseRisk, len(*msg.Risks))
		for i, risk := range *msg.Risks {
			classification := ActivityClassification(risk.Classification)
			reason := ActivityReason(risk.Reason)
			if (classification != ActivityBusy && classification != ActivityUnknown) ||
				!validCloseActivityReason(reason) {
				return CloseOutcome{}, fmt.Errorf("sessiond: close outcome contains invalid risk")
			}
			outcome.Risks[i] = CloseRisk{
				PaneID:         risk.PaneID,
				Title:          risk.Title,
				Classification: classification,
				Reason:         reason,
			}
		}
	case CloseStatusFailed:
		// A malformed or expired opaque ticket has no recoverable target identity
		// at daemon scope. The browser relay overlays its locally-correlated
		// target before forwarding such a failure to the browser.
	default:
		return CloseOutcome{}, fmt.Errorf("sessiond: invalid close outcome status %q", msg.CloseStatus)
	}

	return outcome, nil
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
	SurfaceKind string `json:"surfaceKind,omitempty"` // "terminal" | "browser"; absent = "terminal"
	Cols        int    `json:"cols,omitempty"`
	Rows        int    `json:"rows,omitempty"`
	Title       string `json:"title,omitempty"`
	TotalSeq    uint64 `json:"totalSeq,omitempty"` // exact byte length of the replay data for this pane

	// Layout placement (only present on pane-added events from create-pane requests
	// that carried an explicit placement token; absent means default/tab placement).
	Placement       string `json:"placement,omitempty"`       // tab|split-right|split-left|split-above|split-below
	ReferencePaneID int    `json:"referencePaneId,omitempty"` // pane to split relative to; 0 = active pane
}
