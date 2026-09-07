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
	TypePaneAdded        = "pane-added"
	TypePaneClosed       = "pane-closed"
	TypeWorkspaceClosed  = "workspace-closed"
	TypeWorkspaceRenamed = "workspace-renamed"
	TypePaneRenamed      = "pane-renamed"
	TypeLayoutCommand    = "layout-command" // relay layout mutation to browser clients
	TypeShellPrompt      = "shell-prompt"   // OSC 133 prompt/command lifecycle
	TypePaneResized      = "pane-resized"   // broadcast: canonical PTY size changed

	// Error envelope.
	TypeError = "error"
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

// Session-state message types (ADDITIVE, post-v1). Modelled directly on the
// preview trio above, for the same reasons and with the same guarantees: a
// per-connection opt-in, an explicit acknowledgement so a new browser can
// detect an old daemon, and a droppable advisory push.
//
// TypeSessionStateSubscribe is the opt-in: Message.OK true enables session-state
// pushes for that connection, false disables them. The daemon acknowledges with
// TypeSessionStateSubscribeResult (OK true = "this daemon understands
// session-state and applied it"). A daemon that predates this feature ignores
// the unknown type and never replies, which the client's request timeout
// surfaces as "session state unavailable" rather than a hang.
//
// TypeSessionState is the daemon -> subscriber event carrying the CURRENT FULL
// SET of known sessions in Message.Sessions -- every workspace, not just the
// one this connection is attached to. It is a whole-state document, not a
// delta: the browser replaces its map wholesale, so a dropped frame is repaired
// by the next one instead of leaving a permanently wrong view. That property is
// what makes dropping frames safe, and dropping frames is mandatory here (see
// enqueuePreview in subscriber.go) because this is advisory decoration that must
// never be able to disconnect a live terminal.
//
// Why a batch rather than one message per session: the home view renders the
// whole set at once and reconciles by replacement, an unchanged set then hashes
// to a single value and costs zero bytes, and the existing full-snapshot
// precedent (TypeWorkspaceList carrying Workspaces) already establishes the
// shape.
const (
	TypeSessionStateSubscribe       = "session-state-subscribe"        // request: client -> daemon
	TypeSessionStateSubscribeResult = "session-state-subscribe-result" // reply:   daemon -> client
	TypeSessionState                = "session-state"                  // event:   daemon -> opted-in subscribers
)

// Activity-aware close message types are additive. They preserve the legacy
// force-close messages while routing browser close intents through daemon-owned
// activity and ticket authority.
const (
	TypeCloseIntent  = "close-intent"  // request: browser relay -> daemon
	TypeCloseConfirm = "close-confirm" // request: browser relay -> daemon
	TypeCloseOutcome = "close-outcome" // reply: daemon -> browser relay
)

// Read-only filesystem message types (ADDITIVE, post-v1). They follow the
// TypeScrollbackPage precedent exactly: a client -> daemon request and a
// daemon -> client reply echoing the request cid, with every bound clamped on
// the DAEMON side so no client can ask for more than the daemon will give.
//
// WHY THESE LIVE IN THE PROTOCOL AND NOT IN A TRANSPORT. muxterm reaches a
// remote machine through exactly one thing: a binary-clean byte stream to a
// sessiond socket (internal/transport/transport.go:1). transport.Transport
// offers Dial, Discover, Provision and Identity -- there is deliberately no
// Exec, because SSH's ability to run arbitrary commands is a property of SSH,
// not of remoting, and nothing above internal/transport may assume it. Putting
// a file read here instead means EVERY transport that can carry this protocol
// gains it for free, and no transport has to grow a second, command-shaped
// capability to provide it.
//
// READ-ONLY IS STRUCTURAL. There is no write-file, no create, no delete, no
// rename, no chmod and no exec in this protocol, so there is no argument to
// either message below that can become one: the daemon's switch (server.go)
// reaches fsread.go, which contains no mutating syscall at all. A frame naming
// an operation that does not exist is not dispatched to anything.
//
//	Request (TypeReadFile): Path, Offset (pointer), Limit
//	Reply   (TypeReadFileResult): Path, ResolvedPath, Content, Offset,
//	                              FileSize, NextOffset, EOF, Truncated
//	Request (TypeListDir):  Path, Limit
//	Reply   (TypeListDirResult):  Path, ResolvedPath, Entries, Truncated
const (
	TypeReadFile       = "read-file"        // request: client -> daemon
	TypeReadFileResult = "read-file-result" // reply:   daemon -> client
	TypeListDir        = "list-dir"         // request: client -> daemon
	TypeListDirResult  = "list-dir-result"  // reply:   daemon -> client
)

// Read-only filesystem error codes (ADDITIVE, post-v1). Every distinguishable
// failure gets its own code, because the caller's next move differs for each:
// a missing file is a typo, a directory is a wrong tool, a permission denial
// is an identity problem, an oversized file needs paging, and a binary file
// needs a different question entirely. One generic "read failed" would collapse
// five different next moves into a shrug.
const (
	CodeFSBadPath    = "fs-bad-path"           // not absolute, or otherwise unusable as a path
	CodeFSNotFound   = "fs-not-found"          // no such file or directory
	CodeFSPermission = "fs-permission-denied"  // the daemon's user cannot read it
	CodeFSIsDir      = "fs-is-a-directory"     // read-file aimed at a directory
	CodeFSNotDir     = "fs-not-a-directory"    // list-dir aimed at a non-directory
	CodeFSNotRegular = "fs-not-a-regular-file" // fifo, socket, device: reading would block or lie
	CodeFSTooLarge   = "fs-file-too-large"     // whole-file read of a file past the size bound
	CodeFSNotText    = "fs-not-utf8"           // bytes are not valid UTF-8; not returnable as text
)

// DirEntryInfo is one entry of a TypeListDirResult. It is a wire type with
// fixed JSON tags, following the CloseRiskInfo / SessionState precedent, so its
// spelling is independent of any internal directory representation.
//
// Kind is one of "file", "dir", "symlink" or "other" and comes from an LSTAT,
// so a symlink is reported AS a symlink rather than silently as whatever it
// points at. SymlinkTo carries the raw link target for the same reason: a
// caller navigating a tree must be able to see that it is about to leave the
// place it thinks it is in.
type DirEntryInfo struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Size      int64  `json:"size"`
	Mode      string `json:"mode,omitempty"`
	ModTime   string `json:"modTime,omitempty"`
	SymlinkTo string `json:"symlinkTo,omitempty"`
}

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

	// Layout placement fields (create-pane request → pane-added broadcast → browser dockview)
	Placement       string `json:"placement,omitempty"`       // tab|split-right|split-left|split-above|split-below
	ReferencePaneID int    `json:"referencePaneId,omitempty"` // pane to split relative to; 0 = active pane

	// Relay fields (layout-command, screen-snapshot-result, shell-prompt, get-layout).
	Action   string     `json:"action,omitempty"`   // layout-command verb
	Selector string     `json:"selector,omitempty"` // layout-command placement token
	Text     string     `json:"text,omitempty"`     // plain-text result: screen snapshot
	ExitCode int        `json:"exitCode,omitempty"` // OSC 133 command exit code
	Cursor   *CursorPos `json:"cursor,omitempty"`   // cursor {row,col} for screen snapshot
	ASCII    string     `json:"ascii,omitempty"`    // ASCII layout diagram, get-layout result

	// Real process exit fields (pane-closed only, process-exit-driven close).
	// ProcessExitCode is a pointer so 0 (a normal successful exit) is
	// distinguishable from "field absent" (e.g. a client-requested close,
	// which has no real process exit code).
	ProcessExitCode *int  `json:"processExitCode,omitempty"` // real shell process exit code, set on pane-closed only
	RuntimeMs       int64 `json:"runtimeMs,omitempty"`       // real shell process wall-clock runtime, set on pane-closed only

	// OK is a boolean flag carried by preview-subscribe and
	// session-state-subscribe (opt in/out) and their -result acknowledgements.
	OK bool `json:"ok,omitempty"`

	// Sessions is the payload of TypeSessionState: the full set of agent
	// sessions the daemon currently knows about, across every workspace and
	// every harness. Nothing on this envelope knows which coding-agent CLI
	// produced a row -- see docs/session-state-protocol.md.
	//
	// A typed slice rather than an opaque blob, following the Workspaces /
	// Panes / Risks precedent -- SessionState (sessionstate.go) is already a
	// wire type with fixed JSON tags whose mirror is web/src/lib/session-state.ts,
	// so there is nothing to translate.
	//
	// ABSENT MEANS EMPTY. omitempty is kept for consistency with every other
	// field on this shared envelope (a non-omitempty slice would emit
	// "sessions":null on every control message of every type), which makes the
	// most important transition -- N sessions to zero -- arrive as a bare
	// {"type":"session-state"}. A consumer must therefore treat the ARRIVAL of
	// the message as the signal and a missing field as the empty set, i.e.
	// `replace(msg.sessions ?? [])`, never `if (msg.sessions) replace(...)`.
	// Getting this wrong freezes the home view showing sessions that have
	// ended. Feature availability is detected from the subscribe ack, never
	// from the presence of this field.
	Sessions []SessionState `json:"sessions,omitempty"`

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

	// Read-only filesystem fields (ADDITIVE, post-v1; see TypeReadFile).
	//
	// Limit above is REUSED as the per-call bound for both new operations
	// (maximum bytes for read-file, maximum entries for list-dir), exactly as
	// Lines is already shared between scrollback pages and preview tiles: the
	// uses never appear on the same message, so no second integer field is
	// minted for the same concept.
	//
	// Offset is a POINTER, and the distinction it draws is the whole size
	// policy. Nil means "read this file", and a file past the whole-file size
	// bound is REFUSED with CodeFSTooLarge naming the limit. Non-nil --
	// INCLUDING zero -- means "read this window of this file", which is
	// bounded by construction and therefore allowed at any file size. A plain
	// int64 could not tell "from the start" from "I did not ask to page",
	// which is the same reason BusyCount and ProcessExitCode above are
	// pointers. A NEGATIVE offset counts back from the end, so a bounded tail
	// of an arbitrarily large file costs one round trip and no size guess.
	//
	// ResolvedPath is the path after ~ expansion and symlink resolution, and
	// is always reported. Symlinks are followed, but never silently: when
	// ResolvedPath differs from Path the caller is looking at a different file
	// from the one it named, and it can see that.
	//
	// EOF and Truncated are both needed and are not the same claim. EOF says
	// the returned window reaches the end of the file; Truncated says the
	// answer was cut short by a bound (bytes past Limit, or entries past the
	// directory cap) and more exists.
	Path         string         `json:"path,omitempty"`
	ResolvedPath string         `json:"resolvedPath,omitempty"`
	Offset       *int64         `json:"offset,omitempty"`
	Content      string         `json:"content,omitempty"`
	FileSize     int64          `json:"fileSize,omitempty"`
	NextOffset   *int64         `json:"nextOffset,omitempty"`
	EOF          bool           `json:"eof,omitempty"`
	Truncated    bool           `json:"truncated,omitempty"`
	Entries      []DirEntryInfo `json:"entries,omitempty"`
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

	// Completion is present (ADDITIVE, post-v1) only on a workspace whose
	// lane has finished and has not yet been dismissed. Its presence is what
	// makes a zero-pane workspace a RESULT rather than an empty shell, and it
	// is why such a workspace is not reaped.
	//
	// It rides the workspace list rather than a new event type deliberately:
	// the list is already a whole-state document delivered to every client on
	// every structural change, so a dropped frame repairs itself and an old
	// client that ignores the field simply sees a workspace that lingers.
	Completion *WorkspaceCompletion `json:"completion,omitempty"`
}

// WorkspaceCompletion is the finished-lane annotation on a workspace.
//
// It is a projection of a CompletionRecord (completion.go), carrying enough to
// NAME the lane, state its verdict, and point at what it produced -- without
// shipping the full record to every client on every list broadcast. The
// authoritative record lives in the durable log.
type WorkspaceCompletion struct {
	RecordID string `json:"recordId"`
	PaneID   int    `json:"paneId"`
	// Lane is the human name of what finished. Never empty: a notification
	// that cannot say which lane finished is the bug this feature fixes.
	Lane string `json:"lane"`
	// Outcome is one of the Completion* constants. `completed` is asserted
	// only for a session that declared itself done; a crash is never
	// spelled the same way as a success.
	Outcome  string `json:"outcome"`
	ExitCode int    `json:"exitCode"`
	EndedAt  int64  `json:"endedAt"`
	PR       int    `json:"pr,omitempty"`
	PRURL    string `json:"prUrl,omitempty"`
	Summary  string `json:"summary,omitempty"`
	// Output is a bounded tail of the lane's final screen -- enough to read
	// the result in place. The full capture stays in the record.
	Output string `json:"output,omitempty"`
}

// PaneInfo is one entry in a composition reply or pane-added event.
type PaneInfo struct {
	PaneID   int    `json:"paneId"`
	Cols     int    `json:"cols,omitempty"`
	Rows     int    `json:"rows,omitempty"`
	Title    string `json:"title,omitempty"`
	TotalSeq uint64 `json:"totalSeq,omitempty"` // exact byte length of the replay data for this pane

	// Layout placement (only present on pane-added events from create-pane requests
	// that carried an explicit placement token; absent means default/tab placement).
	Placement       string `json:"placement,omitempty"`       // tab|split-right|split-left|split-above|split-below
	ReferencePaneID int    `json:"referencePaneId,omitempty"` // pane to split relative to; 0 = active pane

	// ClientRef echoes the correlation id the requesting client minted for an
	// optimistic create. Present only on pane-added, never in a composition --
	// a composition is a fresh view of the world, not a reply to anyone's
	// request, which is exactly why the browser must capture the ref on the
	// event and not expect it to survive the next composition.
	//
	// It is load-bearing twice over: the browser settles its optimistic pane
	// on it, and the home view's new-session composer uses it to know which
	// pane the queued first prompt belongs to. Dropping it in the relay is
	// silent -- the pane still appears, the prompt is simply never typed.
	ClientRef string `json:"clientRef,omitempty"`
}
