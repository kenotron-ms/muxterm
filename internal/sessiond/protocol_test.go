package sessiond

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"testing"
)

// TestMessageJSONTagsGolden locks the frozen wire field names by marshaling a
// fully-populated Message and asserting an exact golden string. Go marshals
// struct fields in declaration order, so this output is deterministic.
func TestMessageJSONTagsGolden(t *testing.T) {
	msg := Message{
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

	got, err := json.Marshal(&msg)
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	const want = `{"type":"attach","cid":7,"workspaceId":"ws1","name":"dev","paneId":3,"cols":80,"rows":24,"cmd":["bash","-l"],"title":"shell","workspaces":[{"workspaceId":"ws1","name":"dev","paneCount":2}],"panes":[{"paneId":3,"cols":80,"rows":24,"title":"shell"}],"code":"unknown-workspace","error":"boom"}`

	if string(got) != want {
		t.Errorf("golden mismatch\n got: %s\nwant: %s", got, want)
	}
}

// TestMessageOmitempty asserts that zero-valued optional fields never leak into
// the wire format.
func TestMessageOmitempty(t *testing.T) {
	got, err := json.Marshal(&Message{Type: "ok"})
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	const want = `{"type":"ok"}`
	if string(got) != want {
		t.Errorf("omitempty mismatch\n got: %s\nwant: %s", got, want)
	}
}

// TestMessageRoundTrip marshals then unmarshals a Message and asserts the
// result is deeply equal to the original.
func TestMessageRoundTrip(t *testing.T) {
	original := Message{
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

	data, err := json.Marshal(&original)
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	var decoded Message
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json.Unmarshal returned error: %v", err)
	}

	if !reflect.DeepEqual(original, decoded) {
		t.Errorf("round-trip mismatch\n original: %+v\n decoded:  %+v", original, decoded)
	}
}

// TestWriteControlReadFrameRoundTrip writes a control frame and reads it back,
// asserting the frame kind and the decoded Message envelope.
func TestWriteControlReadFrameRoundTrip(t *testing.T) {
	original := Message{Type: "workspace-created", CID: 5, WorkspaceID: "ws-abc"}

	var buf bytes.Buffer
	if err := WriteControl(&buf, &original); err != nil {
		t.Fatalf("WriteControl returned error: %v", err)
	}

	kind, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame returned error: %v", err)
	}
	if kind != FrameControl {
		t.Fatalf("kind = %#x, want FrameControl (%#x)", kind, FrameControl)
	}

	var decoded Message
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("json.Unmarshal returned error: %v", err)
	}
	if !reflect.DeepEqual(original, decoded) {
		t.Errorf("round-trip mismatch\n original: %+v\n decoded:  %+v", original, decoded)
	}
}

// TestReadFrameSequential writes two control frames back-to-back and reads them
// in order, asserting each frame kind and decoded Type.
func TestReadFrameSequential(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteControl(&buf, &Message{Type: "pane-added", PaneID: 1}); err != nil {
		t.Fatalf("WriteControl (first) returned error: %v", err)
	}
	if err := WriteControl(&buf, &Message{Type: "pane-closed", PaneID: 2}); err != nil {
		t.Fatalf("WriteControl (second) returned error: %v", err)
	}

	wantTypes := []string{"pane-added", "pane-closed"}
	for i, want := range wantTypes {
		kind, payload, err := ReadFrame(&buf)
		if err != nil {
			t.Fatalf("ReadFrame #%d returned error: %v", i, err)
		}
		if kind != FrameControl {
			t.Fatalf("frame #%d kind = %#x, want FrameControl (%#x)", i, kind, FrameControl)
		}
		var decoded Message
		if err := json.Unmarshal(payload, &decoded); err != nil {
			t.Fatalf("frame #%d json.Unmarshal returned error: %v", i, err)
		}
		if decoded.Type != want {
			t.Errorf("frame #%d Type = %q, want %q", i, decoded.Type, want)
		}
	}
}

// TestReadFrameTruncatedHeader asserts ReadFrame returns an error (not a panic
// or a silent zero-frame) when the 4-byte length header is incomplete.
func TestReadFrameTruncatedHeader(t *testing.T) {
	r := bytes.NewReader([]byte{0x00, 0x00})
	_, _, err := ReadFrame(r)
	if err == nil {
		t.Fatal("ReadFrame returned nil error for truncated header, want non-nil")
	}
}

// TestReadFrameTruncatedPayload asserts ReadFrame returns an EOF-flavored error
// when the declared payload length exceeds the available bytes.
func TestReadFrameTruncatedPayload(t *testing.T) {
	r := bytes.NewReader([]byte{0x00, 0x00, 0x00, 0x0a, 0x01, 0x02, 0x03})
	_, _, err := ReadFrame(r)
	if err == nil {
		t.Fatal("ReadFrame returned nil error for truncated payload, want non-nil")
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		t.Errorf("ReadFrame error = %v, want io.ErrUnexpectedEOF or io.EOF", err)
	}
}

// TestWritePaneDataRoundTrip writes a binary-safe pane-data frame and reads it
// back, asserting the frame kind, decoded paneID, and exact byte payload.
func TestWritePaneDataRoundTrip(t *testing.T) {
	data := []byte{'h', 'i', '\n', 0x00, 0xff, '!'}

	var buf bytes.Buffer
	if err := WritePaneData(&buf, 1234, data); err != nil {
		t.Fatalf("WritePaneData returned error: %v", err)
	}

	kind, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame returned error: %v", err)
	}
	if kind != FramePaneData {
		t.Fatalf("kind = %#x, want FramePaneData (%#x)", kind, FramePaneData)
	}

	paneID, gotData := DecodePaneData(payload)
	if paneID != 1234 {
		t.Errorf("paneID = %d, want 1234", paneID)
	}
	if !bytes.Equal(gotData, data) {
		t.Errorf("data = %#v, want %#v", gotData, data)
	}
}

// TestWritePaneDataLittleEndian asserts the on-wire paneId is encoded
// little-endian, matching the existing browser framing that serve bridges
// unchanged.
func TestWritePaneDataLittleEndian(t *testing.T) {
	var buf bytes.Buffer
	if err := WritePaneData(&buf, 1, nil); err != nil {
		t.Fatalf("WritePaneData returned error: %v", err)
	}

	_, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame returned error: %v", err)
	}

	want := []byte{0x01, 0x00, 0x00, 0x00}
	if !bytes.Equal(payload, want) {
		t.Errorf("payload = %#v, want %#v (paneId=1 little-endian, no body)", payload, want)
	}
}

// TestWritePaneDataEmptyBody asserts a pane-data frame with an empty body
// decodes to the correct paneID and a zero-length payload.
func TestWritePaneDataEmptyBody(t *testing.T) {
	var buf bytes.Buffer
	if err := WritePaneData(&buf, 9, []byte{}); err != nil {
		t.Fatalf("WritePaneData returned error: %v", err)
	}

	kind, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame returned error: %v", err)
	}
	if kind != FramePaneData {
		t.Fatalf("kind = %#x, want FramePaneData (%#x)", kind, FramePaneData)
	}

	paneID, data := DecodePaneData(payload)
	if paneID != 9 {
		t.Errorf("paneID = %d, want 9", paneID)
	}
	if len(data) != 0 {
		t.Errorf("len(data) = %d, want 0", len(data))
	}
}

// TestDecodePaneDataShort asserts DecodePaneData defends against a malformed
// payload shorter than the 4-byte paneId header, returning (0, nil) rather than
// panicking.
func TestDecodePaneDataShort(t *testing.T) {
	paneID, data := DecodePaneData([]byte{0x01, 0x02})
	if paneID != 0 {
		t.Errorf("paneID = %d, want 0", paneID)
	}
	if data != nil {
		t.Errorf("data = %#v, want nil", data)
	}
}

// TestTypeConstants locks each named message-type and error-code constant to its
// exact frozen on-wire string, so no phase can hardcode or mistype a raw wire
// literal. The values are FROZEN per the v1 wire protocol contract.
func TestTypeConstants(t *testing.T) {
	cases := []struct {
		got  string
		want string
	}{
		// Requests (client -> daemon)
		{TypeCreateWorkspace, "create-workspace"},
		{TypeListWorkspaces, "list-workspaces"},
		{TypeRenameWorkspace, "rename-workspace"},
		{TypeCloseWorkspace, "close-workspace"},
		{TypeAttach, "attach"},
		{TypeCreatePane, "create-pane"},
		{TypeResize, "resize"},
		// Replies (daemon -> client, echo request cid)
		{TypeWorkspaceCreated, "workspace-created"},
		{TypeWorkspaceList, "workspace-list"},
		{TypeComposition, "composition"},
		{TypePaneCreated, "pane-created"},
		{TypeOK, "ok"},
		// Events (daemon -> all subscribers, cid=0)
		{TypePaneAdded, "pane-added"},
		{TypePaneClosed, "pane-closed"},
		{TypeWorkspaceClosed, "workspace-closed"},
		{TypeWorkspaceRenamed, "workspace-renamed"},
		// Error envelope
		{TypeError, "error"},
		// Error codes (Message.Code values)
		{CodeUnknownWorkspace, "unknown-workspace"},
		{CodePaneSpawnFailed, "pane-spawn-failed"},
	}

	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("constant = %q, want %q", c.got, c.want)
		}
	}
}
