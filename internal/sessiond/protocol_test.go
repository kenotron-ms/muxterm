package sessiond

import (
	"encoding/json"
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
