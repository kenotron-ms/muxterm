# Phase 0 — Frozen Wire Contract Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Produce the single, frozen wire-protocol source of truth (Go + TypeScript) that every later phase imports byte-for-byte, so the daemon, the `serve` relay, and the browser can never again drift into incompatible vocabularies.

**Architecture:** Two transport hops share ONE control vocabulary. The daemon Unix socket uses length-prefixed frames `[4-byte BIG-ENDIAN length][1-byte kind][payload]`; the browser WebSocket carries the SAME JSON `Message` envelope as text frames plus binary pane frames `[4-byte LITTLE-ENDIAN paneId][raw bytes]`. Phase 0 implements ONLY the protocol types, the framing helpers, and their tests — no socket, no PTY, no daemon, no relay. Later phases import these exact symbols.

**Tech Stack:** Go 1.24 (module `github.com/user/muxterm`, stdlib `testing` only — NO testify), TypeScript in `web/src/` (vitest).

**Source of truth (do NOT deviate or "improve"):** `docs/plans/2026-06-01-session-persistence-design.md` → section **"## Wire Protocol (frozen v1 contract)"** (commit `39e8a70`). All struct shapes, JSON tags, frame kinds, helper signatures, message `type` strings, and error codes below are copied EXACTLY from that section.

---

## Why this phase exists (read before starting)

The original five phase plans were authored in parallel; an independent review found **three mutually-incompatible wire protocols** plus Go signature mismatches (e.g. `ReadFrame` called with 3 vs 4 return values, `Message` vs `map[string]any`). Phase 0 freezes the contract so that drift becomes impossible: later phases `import` these symbols rather than re-inventing them.

**The cardinal rule of this phase:** use the EXACT names from the design's frozen section. Do **not** introduce alternatives. The frozen names are:
- Frame kinds: `FrameControl` (`0x01`), `FramePaneData` (`0x02`)
- Helpers: `WriteControl`, `WritePaneData`, `ReadFrame`, `DecodePaneData`
- Structs: `Message`, `WorkspaceInfo`, `PaneInfo`
- JSON tags: `type`, `cid`, `workspaceId`, `name`, `paneId`, `cols`, `rows`, `cmd`, `title`, `workspaces`, `panes`, `code`, `error`, `paneCount`

---

## Scope boundaries

**IN scope (Phase 0):** protocol struct types, message-`type`/error-code string constants, the four framing helpers, and their tests — on BOTH sides of the wire (Go + TypeScript).

**OUT of scope (later phases):** the Unix socket server, PTYs, daemon logic, the `serve` web relay, buffers/rings, lifecycle/auto-spawn. Do NOT create `server.go`, `pane.go`, `buffer.go`, etc. — only `protocol.go` + tests on the Go side, and `types.ts` additions + tests on the TS side.

---

## Files this plan creates or modifies

- **Create:** `internal/sessiond/protocol.go`
- **Create:** `internal/sessiond/protocol_test.go`
- **Modify (append):** `web/src/types.ts`
- **Create:** `web/src/__tests__/protocol.types.test.ts`

---

## Commit convention

Conventional commits. End EVERY commit body with this exact trailer block:

```
🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
```

Do NOT `git push`, merge, or open a PR. Commit locally only.

---

## Task 1: Go `Message` / `WorkspaceInfo` / `PaneInfo` structs + JSON-tag golden test

**Files:**
- Create: `internal/sessiond/protocol.go`
- Create: `internal/sessiond/protocol_test.go`

This task defines the control envelope structs and locks their JSON wire field names with a golden assertion. We do this first so the package compiles and the field-name contract can never silently drift.

**Step 1: Create the initial `protocol.go` with only the structs**

Create `internal/sessiond/protocol.go` with EXACTLY this content:

```go
// Package sessiond defines the frozen v1 wire protocol shared by the daemon,
// the serve relay, and (mirrored in TypeScript) the browser client.
//
// This file is the single source of truth for the control envelope and the
// daemon socket framing. See docs/plans/2026-06-01-session-persistence-design.md
// section "Wire Protocol (frozen v1 contract)". Do NOT rename frame kinds,
// message types, or JSON field tags — every other phase imports these exactly.
package sessiond

// Message is the single control envelope. Every request, reply, event, and
// error is this struct with a different Type. JSON tags are FROZEN.
type Message struct {
	Type        string          `json:"type"`
	CID         uint64          `json:"cid,omitempty"`        // request/reply correlation; 0 = unsolicited event
	WorkspaceID string          `json:"workspaceId,omitempty"`
	Name        string          `json:"name,omitempty"`
	PaneID      int             `json:"paneId,omitempty"` // workspace-local
	Cols        int             `json:"cols,omitempty"`
	Rows        int             `json:"rows,omitempty"`
	Cmd         []string        `json:"cmd,omitempty"` // argv; empty => default $SHELL
	Title       string          `json:"title,omitempty"`
	Workspaces  []WorkspaceInfo `json:"workspaces,omitempty"`
	Panes       []PaneInfo      `json:"panes,omitempty"`
	Code        string          `json:"code,omitempty"`  // error code
	Error       string          `json:"error,omitempty"` // human-readable error text
}

// WorkspaceInfo is one entry in a workspace-list reply.
type WorkspaceInfo struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name,omitempty"`
	PaneCount   int    `json:"paneCount"`
}

// PaneInfo is one entry in a composition reply or pane-added event.
type PaneInfo struct {
	PaneID int    `json:"paneId"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
	Title  string `json:"title,omitempty"`
}
```

**Step 2: Write the failing JSON-tag golden test**

Create `internal/sessiond/protocol_test.go` with EXACTLY this content:

```go
package sessiond

import (
	"encoding/json"
	"reflect"
	"testing"
)

// TestMessageJSONTagsGolden locks the exact wire field names so they can never
// silently drift. Go marshals struct fields in declaration order, so the
// expected string is deterministic.
func TestMessageJSONTagsGolden(t *testing.T) {
	msg := &Message{
		Type:        "attach",
		CID:         7,
		WorkspaceID: "ws1",
		Name:        "dev",
		PaneID:      3,
		Cols:        80,
		Rows:        24,
		Cmd:         []string{"bash", "-l"},
		Title:       "shell",
		Workspaces:  []WorkspaceInfo{{WorkspaceID: "ws1", Name: "dev", PaneCount: 2}},
		Panes:       []PaneInfo{{PaneID: 3, Cols: 80, Rows: 24, Title: "shell"}},
		Code:        "unknown-workspace",
		Error:       "boom",
	}

	got, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	want := `{"type":"attach","cid":7,"workspaceId":"ws1","name":"dev",` +
		`"paneId":3,"cols":80,"rows":24,"cmd":["bash","-l"],"title":"shell",` +
		`"workspaces":[{"workspaceId":"ws1","name":"dev","paneCount":2}],` +
		`"panes":[{"paneId":3,"cols":80,"rows":24,"title":"shell"}],` +
		`"code":"unknown-workspace","error":"boom"}`

	if string(got) != want {
		t.Fatalf("Message JSON drifted.\n got: %s\nwant: %s", got, want)
	}
}

// TestMessageOmitempty verifies a minimal Message marshals to only its type,
// so zero-valued optional fields never leak onto the wire.
func TestMessageOmitempty(t *testing.T) {
	got, err := json.Marshal(&Message{Type: "ok"})
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if string(got) != `{"type":"ok"}` {
		t.Fatalf("omitempty drift: got %s, want {\"type\":\"ok\"}", got)
	}
}

// TestMessageRoundTrip verifies marshal->unmarshal preserves every field.
func TestMessageRoundTrip(t *testing.T) {
	orig := &Message{
		Type:        "composition",
		CID:         42,
		WorkspaceID: "ws9",
		Panes:       []PaneInfo{{PaneID: 1, Cols: 100, Rows: 40, Title: "top"}},
	}
	data, err := json.Marshal(orig)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	var got Message
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(*orig, got) {
		t.Fatalf("round-trip mismatch.\n got: %+v\nwant: %+v", got, *orig)
	}
}
```

**Step 3: Run the tests to verify they PASS**

Because the structs already exist (Step 1), these tests should pass immediately — they are the executable specification of the frozen tags. Run:

`go test -v -run 'TestMessage' ./internal/sessiond/`

Expected output (order may vary):

```
=== RUN   TestMessageJSONTagsGolden
--- PASS: TestMessageJSONTagsGolden (0.00s)
=== RUN   TestMessageOmitempty
--- PASS: TestMessageOmitempty (0.00s)
=== RUN   TestMessageRoundTrip
--- PASS: TestMessageRoundTrip (0.00s)
PASS
ok      github.com/user/muxterm/internal/sessiond
```

If the golden test FAILS, you mistyped a JSON tag — fix `protocol.go` to match the frozen tags exactly; do NOT edit the expected string in the test.

**Step 4: Commit**

```
git add internal/sessiond/protocol.go internal/sessiond/protocol_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): freeze Message/WorkspaceInfo/PaneInfo wire structs

Phase 0 wire contract: the single control envelope with golden JSON-tag
assertions so workspaceId/paneId/cid/paneCount can never drift.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 2: Go control framing helpers `WriteControl` + `ReadFrame`

**Files:**
- Modify: `internal/sessiond/protocol.go` (add framing helpers)
- Modify: `internal/sessiond/protocol_test.go` (add framing tests)

This adds the daemon socket framing for control frames: `[4-byte BIG-ENDIAN length][1-byte kind][payload]`, where the length covers the kind byte plus the payload.

**Step 1: Write the failing control-framing tests**

Append the following to `internal/sessiond/protocol_test.go` (add `"bytes"`, `"errors"`, and `"io"` to its import block — the final import block should be `"bytes"`, `"encoding/json"`, `"errors"`, `"io"`, `"reflect"`, `"testing"`):

```go
func TestWriteControlReadFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	orig := &Message{Type: "workspace-created", CID: 5, WorkspaceID: "ws-abc"}

	if err := WriteControl(&buf, orig); err != nil {
		t.Fatalf("WriteControl: %v", err)
	}

	kind, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if kind != FrameControl {
		t.Fatalf("kind = 0x%02x, want FrameControl (0x%02x)", kind, FrameControl)
	}

	var got Message
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatalf("json.Unmarshal payload: %v", err)
	}
	// Message contains slice fields, so it is not comparable with ==; use DeepEqual.
	if !reflect.DeepEqual(got, *orig) {
		t.Fatalf("round-trip mismatch.\n got: %+v\nwant: %+v", got, *orig)
	}
}

// TestReadFrameSequential proves two frames written back-to-back are read in order.
func TestReadFrameSequential(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteControl(&buf, &Message{Type: "pane-added", PaneID: 1}); err != nil {
		t.Fatalf("WriteControl 1: %v", err)
	}
	if err := WriteControl(&buf, &Message{Type: "pane-closed", PaneID: 2}); err != nil {
		t.Fatalf("WriteControl 2: %v", err)
	}

	for i, wantType := range []string{"pane-added", "pane-closed"} {
		kind, payload, err := ReadFrame(&buf)
		if err != nil {
			t.Fatalf("ReadFrame %d: %v", i, err)
		}
		if kind != FrameControl {
			t.Fatalf("frame %d kind = 0x%02x, want FrameControl", i, kind)
		}
		var m Message
		if err := json.Unmarshal(payload, &m); err != nil {
			t.Fatalf("frame %d unmarshal: %v", i, err)
		}
		if m.Type != wantType {
			t.Fatalf("frame %d type = %q, want %q", i, m.Type, wantType)
		}
	}
}

// TestReadFrameTruncatedHeader verifies a short length prefix is an error,
// not a panic or silent zero-frame.
func TestReadFrameTruncatedHeader(t *testing.T) {
	r := bytes.NewReader([]byte{0x00, 0x00}) // only 2 of the 4 length bytes
	_, _, err := ReadFrame(r)
	if err == nil {
		t.Fatal("ReadFrame on truncated header: want error, got nil")
	}
}

// TestReadFrameTruncatedPayload verifies a length that promises more bytes than
// are present is an error.
func TestReadFrameTruncatedPayload(t *testing.T) {
	// length=10 (big-endian) but only 3 bytes follow.
	r := bytes.NewReader([]byte{0x00, 0x00, 0x00, 0x0a, 0x01, 0x02, 0x03})
	_, _, err := ReadFrame(r)
	if err == nil {
		t.Fatal("ReadFrame on truncated payload: want error, got nil")
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		t.Fatalf("want EOF-family error, got %v", err)
	}
}
```

**Step 2: Run the tests to verify they FAIL (compile error)**

Run: `go test -run 'TestWriteControl|TestReadFrame' ./internal/sessiond/`

Expected: FAIL — compile errors `undefined: WriteControl`, `undefined: ReadFrame`, `undefined: FrameControl`.

**Step 3: Add the frame kinds + control framing helpers to `protocol.go`**

Add this import block and these declarations to `internal/sessiond/protocol.go` (place the imports right under the `package sessiond` doc comment, and the code below the structs):

```go
import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

// Frame kinds for the daemon Unix-socket framing.
//
//	[4-byte BIG-ENDIAN length][1-byte kind][payload]
//
// The length field covers the kind byte plus the payload.
const (
	FrameControl  byte = 0x01 // payload is JSON of the Message envelope
	FramePaneData byte = 0x02 // payload is [4-byte LITTLE-ENDIAN paneId][raw bytes]
)

// writeFrame writes a single framed message: a 4-byte big-endian length
// (kind byte + payload), the kind byte, then the payload.
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

// ReadFrame reads one framed message and returns its kind and raw payload.
// For FrameControl the payload is JSON; for FramePaneData decode it with
// DecodePaneData. A truncated header or payload returns an error.
func ReadFrame(r io.Reader) (kind byte, payload []byte, err error) {
	var hdr [4]byte
	if _, err = io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	total := binary.BigEndian.Uint32(hdr[:])
	if total < 1 {
		return 0, nil, fmt.Errorf("sessiond: frame length %d too short (need >=1 for kind byte)", total)
	}
	buf := make([]byte, total)
	if _, err = io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return buf[0], buf[1:], nil
}
```

> Note: Go does not allow two `import` blocks in one file. If `protocol.go` already has an import block, MERGE these imports into it rather than adding a second block. After Task 1 there was no import block yet, so add this one.

**Step 4: Run the tests to verify they PASS**

Run: `go test -v -run 'TestWriteControl|TestReadFrame' ./internal/sessiond/`

Expected: all four tests `PASS`, ending with `ok  github.com/user/muxterm/internal/sessiond`.

**Step 5: Commit**

```
git add internal/sessiond/protocol.go internal/sessiond/protocol_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): add FrameControl framing helpers WriteControl/ReadFrame

Length-prefixed [4-byte BE len][1-byte kind][payload] framing with
round-trip, sequential, and truncation tests.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 3: Go pane-data framing helpers `WritePaneData` + `DecodePaneData`

**Files:**
- Modify: `internal/sessiond/protocol.go` (add pane-data helpers)
- Modify: `internal/sessiond/protocol_test.go` (add binary round-trip tests)

This adds the binary pane frame: payload is `[4-byte LITTLE-ENDIAN paneId][raw bytes]`. The little-endian paneId matches the existing browser framing so `serve` bridges the body without rewriting it. The body is binary-safe (may contain newlines and NUL bytes).

**Step 1: Write the failing pane-data tests**

Append to `internal/sessiond/protocol_test.go`:

```go
func TestWritePaneDataRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	// Binary-safe payload: embedded newline and NUL, plus a high byte.
	data := []byte{'h', 'i', '\n', 0x00, 0xff, '!'}

	if err := WritePaneData(&buf, 1234, data); err != nil {
		t.Fatalf("WritePaneData: %v", err)
	}

	kind, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if kind != FramePaneData {
		t.Fatalf("kind = 0x%02x, want FramePaneData (0x%02x)", kind, FramePaneData)
	}

	paneID, gotData := DecodePaneData(payload)
	if paneID != 1234 {
		t.Fatalf("paneID = %d, want 1234", paneID)
	}
	if !bytes.Equal(gotData, data) {
		t.Fatalf("data = %v, want %v", gotData, data)
	}
}

// TestWritePaneDataLittleEndian asserts the on-wire paneId byte order is
// little-endian, matching the browser framing serve bridges unchanged.
func TestWritePaneDataLittleEndian(t *testing.T) {
	var buf bytes.Buffer
	if err := WritePaneData(&buf, 1, nil); err != nil {
		t.Fatalf("WritePaneData: %v", err)
	}
	_, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	want := []byte{0x01, 0x00, 0x00, 0x00} // paneId=1, little-endian, no body
	if !bytes.Equal(payload, want) {
		t.Fatalf("pane payload = %v, want %v (little-endian)", payload, want)
	}
}

// TestWritePaneDataEmptyBody verifies a zero-length body round-trips: the frame
// carries only the 4-byte paneId.
func TestWritePaneDataEmptyBody(t *testing.T) {
	var buf bytes.Buffer
	if err := WritePaneData(&buf, 9, []byte{}); err != nil {
		t.Fatalf("WritePaneData: %v", err)
	}
	kind, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if kind != FramePaneData {
		t.Fatalf("kind = 0x%02x, want FramePaneData", kind)
	}
	paneID, data := DecodePaneData(payload)
	if paneID != 9 {
		t.Fatalf("paneID = %d, want 9", paneID)
	}
	if len(data) != 0 {
		t.Fatalf("data len = %d, want 0", len(data))
	}
}

// TestDecodePaneDataShort verifies a malformed (<4 byte) payload is handled
// defensively rather than panicking.
func TestDecodePaneDataShort(t *testing.T) {
	paneID, data := DecodePaneData([]byte{0x01, 0x02})
	if paneID != 0 || data != nil {
		t.Fatalf("short DecodePaneData = (%d, %v), want (0, nil)", paneID, data)
	}
}
```

**Step 2: Run the tests to verify they FAIL (compile error)**

Run: `go test -run 'TestWritePaneData|TestDecodePaneData' ./internal/sessiond/`

Expected: FAIL — `undefined: WritePaneData`, `undefined: DecodePaneData`.

**Step 3: Add the pane-data helpers to `protocol.go`**

Append these two functions to `internal/sessiond/protocol.go` (no new imports needed — `encoding/binary` is already imported from Task 2):

```go
// WritePaneData writes a FramePaneData frame whose payload is
// [4-byte LITTLE-ENDIAN paneID][data]. The body is binary-safe.
func WritePaneData(w io.Writer, paneID uint32, data []byte) error {
	payload := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(payload[0:4], paneID)
	copy(payload[4:], data)
	return writeFrame(w, FramePaneData, payload)
}

// DecodePaneData splits a FramePaneData payload into its little-endian paneID
// and the raw body. A payload shorter than 4 bytes returns (0, nil).
func DecodePaneData(payload []byte) (paneID uint32, data []byte) {
	if len(payload) < 4 {
		return 0, nil
	}
	return binary.LittleEndian.Uint32(payload[0:4]), payload[4:]
}
```

**Step 4: Run the tests to verify they PASS, with the race detector**

Run: `go test -race -v -run 'TestWritePaneData|TestDecodePaneData' ./internal/sessiond/`

Expected: all four tests `PASS`, ending with `ok  github.com/user/muxterm/internal/sessiond`.

**Step 5: Commit**

```
git add internal/sessiond/protocol.go internal/sessiond/protocol_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): add FramePaneData helpers WritePaneData/DecodePaneData

Binary-safe [4-byte LE paneId][bytes] framing matching the browser
wire so serve bridges the body unchanged. Round-trip + endianness tests.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 4: Go message-`type` and error-code string constants

**Files:**
- Modify: `internal/sessiond/protocol.go` (add string constants)
- Modify: `internal/sessiond/protocol_test.go` (add constant-value test)

This gives every phase named constants for the frozen `type` strings and error codes, so no phase ever hardcodes a raw `"attach"` literal that could be mistyped.

**Step 1: Write the failing constant-value test**

Append to `internal/sessiond/protocol_test.go`:

```go
// TestTypeConstants locks the exact on-wire string for every message type and
// error code. These values are the contract; later phases compare against them.
func TestTypeConstants(t *testing.T) {
	cases := []struct {
		got  string
		want string
	}{
		// Requests.
		{TypeCreateWorkspace, "create-workspace"},
		{TypeListWorkspaces, "list-workspaces"},
		{TypeRenameWorkspace, "rename-workspace"},
		{TypeCloseWorkspace, "close-workspace"},
		{TypeAttach, "attach"},
		{TypeCreatePane, "create-pane"},
		{TypeResize, "resize"},
		// Replies.
		{TypeWorkspaceCreated, "workspace-created"},
		{TypeWorkspaceList, "workspace-list"},
		{TypeComposition, "composition"},
		{TypePaneCreated, "pane-created"},
		{TypeOK, "ok"},
		// Events.
		{TypePaneAdded, "pane-added"},
		{TypePaneClosed, "pane-closed"},
		{TypeWorkspaceClosed, "workspace-closed"},
		{TypeWorkspaceRenamed, "workspace-renamed"},
		// Error.
		{TypeError, "error"},
		// Error codes.
		{CodeUnknownWorkspace, "unknown-workspace"},
		{CodePaneSpawnFailed, "pane-spawn-failed"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("constant = %q, want %q", c.got, c.want)
		}
	}
}
```

**Step 2: Run the test to verify it FAILS (compile error)**

Run: `go test -run TestTypeConstants ./internal/sessiond/`

Expected: FAIL — `undefined: TypeCreateWorkspace` (and the rest).

**Step 3: Add the constants to `protocol.go`**

Append to `internal/sessiond/protocol.go`:

```go
// Message type strings (the on-wire value of Message.Type). FROZEN.
const (
	// Requests (client -> daemon).
	TypeCreateWorkspace = "create-workspace"
	TypeListWorkspaces  = "list-workspaces"
	TypeRenameWorkspace = "rename-workspace"
	TypeCloseWorkspace  = "close-workspace"
	TypeAttach          = "attach"
	TypeCreatePane      = "create-pane"
	TypeResize          = "resize"

	// Replies (daemon -> client; echo the request cid).
	TypeWorkspaceCreated = "workspace-created"
	TypeWorkspaceList    = "workspace-list"
	TypeComposition      = "composition"
	TypePaneCreated      = "pane-created"
	TypeOK               = "ok"

	// Events (daemon -> all subscribers; cid=0).
	TypePaneAdded        = "pane-added"
	TypePaneClosed       = "pane-closed"
	TypeWorkspaceClosed  = "workspace-closed"
	TypeWorkspaceRenamed = "workspace-renamed"

	// Error envelope.
	TypeError = "error"
)

// Error codes (the on-wire value of Message.Code). FROZEN.
const (
	CodeUnknownWorkspace = "unknown-workspace"
	CodePaneSpawnFailed  = "pane-spawn-failed"
)
```

**Step 4: Run the full Go package suite to verify everything PASSES**

Run: `go test -race -v ./internal/sessiond/`

Expected: every `TestMessage*`, `TestWriteControl*`, `TestReadFrame*`, `TestWritePaneData*`, `TestDecodePaneData*`, and `TestTypeConstants` reports `PASS`, ending with `ok  github.com/user/muxterm/internal/sessiond`.

Also run `go vet ./internal/sessiond/` and confirm it prints nothing (clean).

**Step 5: Commit**

```
git add internal/sessiond/protocol.go internal/sessiond/protocol_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): add frozen message-type and error-code constants

Named constants for every Message.Type and error Code so no phase
hardcodes a raw wire string. Values locked by TestTypeConstants.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 5: TypeScript mirror types + literal constants

**Files:**
- Modify (append): `web/src/types.ts`
- Create: `web/src/__tests__/protocol.types.test.ts`

This mirrors the Go `Message`/`WorkspaceInfo`/`PaneInfo` shapes and the frozen `type` literals into TypeScript so the browser speaks the exact same vocabulary. Field names match the Go JSON tags byte-for-byte.

> Note on `cid`: Go's `cid` is `uint64`. JavaScript numbers safely represent integers up to 2^53; `cid` values are small monotonic counters, so a `number` is fine. Do NOT widen it to `bigint`.

**Step 1: Write the failing TypeScript test**

Create `web/src/__tests__/protocol.types.test.ts` with EXACTLY this content:

```ts
import { describe, it, expect } from 'vitest';
import {
  SessiondType,
  SessiondErrorCode,
  type SessiondMessage,
  type SessiondWorkspaceInfo,
  type SessiondPaneInfo,
} from '../types';

describe('sessiond wire-protocol literals', () => {
  it('matches the frozen Go message-type strings', () => {
    expect(SessiondType).toEqual({
      CreateWorkspace: 'create-workspace',
      ListWorkspaces: 'list-workspaces',
      RenameWorkspace: 'rename-workspace',
      CloseWorkspace: 'close-workspace',
      Attach: 'attach',
      CreatePane: 'create-pane',
      Resize: 'resize',
      WorkspaceCreated: 'workspace-created',
      WorkspaceList: 'workspace-list',
      Composition: 'composition',
      PaneCreated: 'pane-created',
      Ok: 'ok',
      PaneAdded: 'pane-added',
      PaneClosed: 'pane-closed',
      WorkspaceClosed: 'workspace-closed',
      WorkspaceRenamed: 'workspace-renamed',
      Error: 'error',
    });
  });

  it('matches the frozen Go error codes', () => {
    expect(SessiondErrorCode).toEqual({
      UnknownWorkspace: 'unknown-workspace',
      PaneSpawnFailed: 'pane-spawn-failed',
    });
  });

  it('serializes a Message with the exact Go JSON field names', () => {
    const msg: SessiondMessage = {
      type: SessiondType.Attach,
      cid: 7,
      workspaceId: 'ws1',
      paneId: 3,
      cols: 80,
      rows: 24,
    };
    const parsed = JSON.parse(JSON.stringify(msg));
    expect(Object.keys(parsed).sort()).toEqual(
      ['cid', 'cols', 'paneId', 'rows', 'type', 'workspaceId'].sort(),
    );
  });

  it('models WorkspaceInfo and PaneInfo with frozen field names', () => {
    const ws: SessiondWorkspaceInfo = { workspaceId: 'ws1', name: 'dev', paneCount: 2 };
    const pane: SessiondPaneInfo = { paneId: 3, cols: 80, rows: 24, title: 'shell' };
    expect(Object.keys(ws).sort()).toEqual(['name', 'paneCount', 'workspaceId'].sort());
    expect(Object.keys(pane).sort()).toEqual(['cols', 'paneId', 'rows', 'title'].sort());
  });
});
```

**Step 2: Run the test to verify it FAILS**

Run (from the repo root): `cd web && npx vitest run src/__tests__/protocol.types.test.ts`

Expected: FAIL — the import of `SessiondType` etc. from `../types` cannot be resolved (the symbols do not exist yet).

**Step 3: Append the mirror types to `web/src/types.ts`**

Append this block to the END of `web/src/types.ts` (do not modify the existing tmux types above it):

```ts
// ─── Sessiond wire protocol (frozen v1 contract) ───────────────────────────
// Mirror of internal/sessiond/protocol.go. Field names MUST match the Go JSON
// tags byte-for-byte. Source of truth:
// docs/plans/2026-06-01-session-persistence-design.md → "Wire Protocol (frozen v1 contract)".

/** Frozen on-wire values for SessiondMessage.type. */
export const SessiondType = {
  // Requests (client -> daemon).
  CreateWorkspace: 'create-workspace',
  ListWorkspaces: 'list-workspaces',
  RenameWorkspace: 'rename-workspace',
  CloseWorkspace: 'close-workspace',
  Attach: 'attach',
  CreatePane: 'create-pane',
  Resize: 'resize',
  // Replies (daemon -> client; echo the request cid).
  WorkspaceCreated: 'workspace-created',
  WorkspaceList: 'workspace-list',
  Composition: 'composition',
  PaneCreated: 'pane-created',
  Ok: 'ok',
  // Events (daemon -> all subscribers; cid=0).
  PaneAdded: 'pane-added',
  PaneClosed: 'pane-closed',
  WorkspaceClosed: 'workspace-closed',
  WorkspaceRenamed: 'workspace-renamed',
  // Error envelope.
  Error: 'error',
} as const;

/** Union of all valid SessiondMessage.type strings. */
export type SessiondMessageType = (typeof SessiondType)[keyof typeof SessiondType];

/** Frozen on-wire values for SessiondMessage.code (error envelope). */
export const SessiondErrorCode = {
  UnknownWorkspace: 'unknown-workspace',
  PaneSpawnFailed: 'pane-spawn-failed',
} as const;

/** Union of all valid error codes. */
export type SessiondErrorCodeValue =
  (typeof SessiondErrorCode)[keyof typeof SessiondErrorCode];

/** Mirror of Go sessiond.WorkspaceInfo. */
export interface SessiondWorkspaceInfo {
  workspaceId: string;
  name?: string;
  paneCount: number;
}

/** Mirror of Go sessiond.PaneInfo. */
export interface SessiondPaneInfo {
  paneId: number;
  cols: number;
  rows: number;
  title?: string;
}

/**
 * Mirror of Go sessiond.Message — the single control envelope. Every request,
 * reply, event, and error is this shape with a different `type`. Optional
 * fields are omitted on the wire (Go `omitempty`).
 *
 * `cid` is a uint64 on the Go side; values are small monotonic counters that
 * fit safely in a JS number.
 */
export interface SessiondMessage {
  type: SessiondMessageType;
  cid?: number;
  workspaceId?: string;
  name?: string;
  paneId?: number;
  cols?: number;
  rows?: number;
  cmd?: string[];
  title?: string;
  workspaces?: SessiondWorkspaceInfo[];
  panes?: SessiondPaneInfo[];
  code?: SessiondErrorCodeValue;
  error?: string;
}
```

**Step 4: Run the test to verify it PASSES**

Run: `cd web && npx vitest run src/__tests__/protocol.types.test.ts`

Expected: `Test Files  1 passed (1)` and `Tests  4 passed (4)`.

**Step 5: Commit**

```
git add web/src/types.ts web/src/__tests__/protocol.types.test.ts
git commit -m "$(cat <<'EOF'
feat(web): mirror frozen sessiond wire types into TypeScript

SessiondMessage/WorkspaceInfo/PaneInfo plus SessiondType and
SessiondErrorCode literal maps, field names matching the Go JSON tags.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 6: TypeScript binary pane-frame helpers

**Files:**
- Modify (append): `web/src/types.ts`
- Modify: `web/src/__tests__/protocol.types.test.ts` (add binary-frame tests)

This adds the browser-side encode/decode for the binary WebSocket pane frame `[4-byte LITTLE-ENDIAN paneId][raw bytes]`, matching the layout already used in `web/src/ws.ts` (and the Go `WritePaneData`/`DecodePaneData` payload). Centralizing it here lets `ws.ts` and later phases share ONE implementation.

**Step 1: Write the failing binary-frame tests**

Append these tests to `web/src/__tests__/protocol.types.test.ts`. Also extend the existing import at the top of that file to include `encodePaneFrame` and `decodePaneFrame`:

```ts
import {
  SessiondType,
  SessiondErrorCode,
  encodePaneFrame,
  decodePaneFrame,
  type SessiondMessage,
  type SessiondWorkspaceInfo,
  type SessiondPaneInfo,
} from '../types';
```

(Replace the existing import block from Task 5 with the one above — it adds the two helper imports.)

Then append this `describe` block to the end of the file:

```ts
describe('sessiond binary pane frame', () => {
  it('round-trips a binary-safe payload (newline + NUL + high byte)', () => {
    const data = new Uint8Array([0x68, 0x69, 0x0a, 0x00, 0xff, 0x21]);
    const frame = encodePaneFrame(1234, data);
    const { paneId, data: got } = decodePaneFrame(frame);
    expect(paneId).toBe(1234);
    expect(Array.from(got)).toEqual(Array.from(data));
  });

  it('writes the paneId little-endian to match the Go wire', () => {
    const frame = encodePaneFrame(1, new Uint8Array());
    const bytes = new Uint8Array(frame);
    // paneId=1, little-endian, no body.
    expect(Array.from(bytes)).toEqual([0x01, 0x00, 0x00, 0x00]);
  });

  it('round-trips an empty body', () => {
    const frame = encodePaneFrame(9, new Uint8Array());
    const { paneId, data } = decodePaneFrame(frame);
    expect(paneId).toBe(9);
    expect(data.length).toBe(0);
  });
});
```

**Step 2: Run the tests to verify they FAIL**

Run: `cd web && npx vitest run src/__tests__/protocol.types.test.ts`

Expected: FAIL — `encodePaneFrame` / `decodePaneFrame` are not exported from `../types`.

**Step 3: Append the binary-frame helpers to `web/src/types.ts`**

Append to the END of `web/src/types.ts`:

```ts
/**
 * Encode a browser-WebSocket pane frame: [4-byte LE paneId][raw bytes].
 * Mirrors the Go FramePaneData payload so serve bridges it without rewriting.
 */
export function encodePaneFrame(paneId: number, data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(4 + data.length);
  const view = new DataView(buf);
  view.setUint32(0, paneId, true); // little-endian
  new Uint8Array(buf, 4).set(data);
  return buf;
}

/**
 * Decode a browser-WebSocket pane frame: [4-byte LE paneId][raw bytes].
 * The returned data view aliases the input buffer (no copy).
 */
export function decodePaneFrame(buf: ArrayBuffer): { paneId: number; data: Uint8Array } {
  const view = new DataView(buf);
  const paneId = view.getUint32(0, true); // little-endian
  const data = new Uint8Array(buf, 4);
  return { paneId, data };
}
```

**Step 4: Run the full web test file to verify it PASSES**

Run: `cd web && npx vitest run src/__tests__/protocol.types.test.ts`

Expected: `Test Files  1 passed (1)` and `Tests  7 passed (7)`.

Then confirm the TypeScript compiler is happy across the project — run: `cd web && npx tsc --noEmit` and confirm it prints nothing (clean).

**Step 5: Commit**

```
git add web/src/types.ts web/src/__tests__/protocol.types.test.ts
git commit -m "$(cat <<'EOF'
feat(web): add binary pane-frame encode/decode helpers

encodePaneFrame/decodePaneFrame for the [4-byte LE paneId][bytes]
WebSocket frame, matching Go WritePaneData/DecodePaneData. One shared
implementation for ws.ts and later phases.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Final verification (run after Task 6)

Confirm BOTH sides of the wire are green and clean:

1. **Go:** `go test -race ./internal/sessiond/` → `ok  github.com/user/muxterm/internal/sessiond`
2. **Go vet:** `go vet ./internal/sessiond/` → no output
3. **Web tests:** `cd web && npx vitest run src/__tests__/protocol.types.test.ts` → `Tests  7 passed (7)`
4. **Web types:** `cd web && npx tsc --noEmit` → no output

If all four are clean, Phase 0 is done: the frozen contract now exists as code on both sides of the wire. Every later phase MUST `import` these symbols (`WriteControl`, `WritePaneData`, `ReadFrame`, `DecodePaneData`, `FrameControl`, `FramePaneData`, `Message`, `WorkspaceInfo`, `PaneInfo`, the `Type*`/`Code*` constants, and the TS `Sessiond*` mirrors) rather than re-declaring them.

---

## Handoff note for later phases

- **Phase 1 (sessiond core):** imports everything here as-is. It implements the server lifecycle signatures (`NewServer`, `ListenAndServe`, `SocketPath`, `DefaultLogPath`, `EnsureDaemon`) and the connection/delivery model from the design — it does NOT redefine any protocol symbol.
- **Phase 3 (serve relay):** uses `ReadFrame` with the **3-value** signature `(kind, payload, err)` and `WriteControl(w, *Message)` (typed, not `map[string]any`). The earlier Phase 3 draft that called `ReadFrame` with 4 values and passed `map[string]any` was the drift this phase exists to kill — it must be re-baselined to these signatures.
- **Phase 4 (browser):** imports `SessiondType`, `SessiondErrorCode`, `SessiondMessage`, and `encodePaneFrame`/`decodePaneFrame`. Its recovery state machine keys off `SessiondType.WorkspaceClosed` / `SessiondErrorCode.UnknownWorkspace` — the exact strings frozen here.
