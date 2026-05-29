package tmux

import (
	"bufio"
	"bytes"
	"io"
	"strings"
	"testing"
	"time"
)

func TestParseEvent_OutputPlain(t *testing.T) {
	ev, err := ParseEvent("%output %42 hello world")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out, ok := ev.(OutputEvent)
	if !ok {
		t.Fatalf("expected OutputEvent, got %T", ev)
	}
	if out.PaneID != "%42" {
		t.Errorf("PaneID: got %q, want %q", out.PaneID, "%42")
	}
	if !bytes.Equal(out.Data, []byte("hello world")) {
		t.Errorf("Data: got %q, want %q", out.Data, "hello world")
	}
}

func TestParseEvent_OutputOctalEscape(t *testing.T) {
	// \012 is octal for newline (10)
	ev, err := ParseEvent(`%output %42 hello\012world`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out, ok := ev.(OutputEvent)
	if !ok {
		t.Fatalf("expected OutputEvent, got %T", ev)
	}
	if out.PaneID != "%42" {
		t.Errorf("PaneID: got %q, want %q", out.PaneID, "%42")
	}
	want := []byte("hello\nworld")
	if !bytes.Equal(out.Data, want) {
		t.Errorf("Data: got %q, want %q", out.Data, want)
	}
}

func TestParseEvent_OutputBackslashEscape(t *testing.T) {
	// \134 is octal for backslash (92)
	ev, err := ParseEvent(`%output %42 path\134name`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out, ok := ev.(OutputEvent)
	if !ok {
		t.Fatalf("expected OutputEvent, got %T", ev)
	}
	want := []byte(`path\name`)
	if !bytes.Equal(out.Data, want) {
		t.Errorf("Data: got %q, want %q", out.Data, want)
	}
}

func TestParseEvent_LayoutChange(t *testing.T) {
	ev, err := ParseEvent("%layout-change @1 abc123,200x50,0,0,42 abc123,200x50,0,0,42 *")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	lc, ok := ev.(LayoutChangeEvent)
	if !ok {
		t.Fatalf("expected LayoutChangeEvent, got %T", ev)
	}
	if lc.WindowID != "@1" {
		t.Errorf("WindowID: got %q, want %q", lc.WindowID, "@1")
	}
	if lc.Layout != "abc123,200x50,0,0,42" {
		t.Errorf("Layout: got %q, want %q", lc.Layout, "abc123,200x50,0,0,42")
	}
	if lc.VisibleLayout != "abc123,200x50,0,0,42" {
		t.Errorf("VisibleLayout: got %q, want %q", lc.VisibleLayout, "abc123,200x50,0,0,42")
	}
	if lc.Flags != "*" {
		t.Errorf("Flags: got %q, want %q", lc.Flags, "*")
	}
}

func TestParseEvent_WindowAdd(t *testing.T) {
	ev, err := ParseEvent("%window-add @1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wa, ok := ev.(WindowAddEvent)
	if !ok {
		t.Fatalf("expected WindowAddEvent, got %T", ev)
	}
	if wa.WindowID != "@1" {
		t.Errorf("WindowID: got %q, want %q", wa.WindowID, "@1")
	}
}

func TestParseEvent_WindowClose(t *testing.T) {
	ev, err := ParseEvent("%window-close @3")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wc, ok := ev.(WindowCloseEvent)
	if !ok {
		t.Fatalf("expected WindowCloseEvent, got %T", ev)
	}
	if wc.WindowID != "@3" {
		t.Errorf("WindowID: got %q, want %q", wc.WindowID, "@3")
	}
}

func TestParseEvent_WindowRenamed(t *testing.T) {
	ev, err := ParseEvent("%window-renamed @1 my-window")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wr, ok := ev.(WindowRenamedEvent)
	if !ok {
		t.Fatalf("expected WindowRenamedEvent, got %T", ev)
	}
	if wr.WindowID != "@1" {
		t.Errorf("WindowID: got %q, want %q", wr.WindowID, "@1")
	}
	if wr.Name != "my-window" {
		t.Errorf("Name: got %q, want %q", wr.Name, "my-window")
	}
}

func TestParseEvent_SessionChanged(t *testing.T) {
	ev, err := ParseEvent("%session-changed $1 my-session")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	sc, ok := ev.(SessionChangedEvent)
	if !ok {
		t.Fatalf("expected SessionChangedEvent, got %T", ev)
	}
	if sc.SessionID != "$1" {
		t.Errorf("SessionID: got %q, want %q", sc.SessionID, "$1")
	}
	if sc.Name != "my-session" {
		t.Errorf("Name: got %q, want %q", sc.Name, "my-session")
	}
}

func TestParseEvent_SessionWindowChanged(t *testing.T) {
	ev, err := ParseEvent("%session-window-changed $1 @2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	swc, ok := ev.(SessionWindowChangedEvent)
	if !ok {
		t.Fatalf("expected SessionWindowChangedEvent, got %T", ev)
	}
	if swc.SessionID != "$1" {
		t.Errorf("SessionID: got %q, want %q", swc.SessionID, "$1")
	}
	if swc.WindowID != "@2" {
		t.Errorf("WindowID: got %q, want %q", swc.WindowID, "@2")
	}
}

func TestParseEvent_SessionRenamed(t *testing.T) {
	ev, err := ParseEvent("%session-renamed new-name")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	sr, ok := ev.(SessionRenamedEvent)
	if !ok {
		t.Fatalf("expected SessionRenamedEvent, got %T", ev)
	}
	if sr.Name != "new-name" {
		t.Errorf("Name: got %q, want %q", sr.Name, "new-name")
	}
}

func TestParseEvent_SessionsChanged(t *testing.T) {
	ev, err := ParseEvent("%sessions-changed")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_, ok := ev.(SessionsChangedEvent)
	if !ok {
		t.Fatalf("expected SessionsChangedEvent, got %T", ev)
	}
}

func TestParseEvent_PaneModeChanged(t *testing.T) {
	ev, err := ParseEvent("%pane-mode-changed %5")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	pm, ok := ev.(PaneModeChangedEvent)
	if !ok {
		t.Fatalf("expected PaneModeChangedEvent, got %T", ev)
	}
	if pm.PaneID != "%5" {
		t.Errorf("PaneID: got %q, want %q", pm.PaneID, "%5")
	}
}

func TestParseEvent_WindowPaneChanged(t *testing.T) {
	ev, err := ParseEvent("%window-pane-changed @1 %2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wpc, ok := ev.(WindowPaneChangedEvent)
	if !ok {
		t.Fatalf("expected WindowPaneChangedEvent, got %T", ev)
	}
	if wpc.WindowID != "@1" {
		t.Errorf("WindowID: got %q, want %q", wpc.WindowID, "@1")
	}
	if wpc.PaneID != "%2" {
		t.Errorf("PaneID: got %q, want %q", wpc.PaneID, "%2")
	}
}

func TestParseEvent_Exit(t *testing.T) {
	// Empty exit (no reason)
	ev, err := ParseEvent("%exit")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ex, ok := ev.(ExitEvent)
	if !ok {
		t.Fatalf("expected ExitEvent, got %T", ev)
	}
	if ex.Reason != "" {
		t.Errorf("Reason: got %q, want empty", ex.Reason)
	}

	// Exit with reason
	ev2, err := ParseEvent("%exit server exited")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ex2, ok := ev2.(ExitEvent)
	if !ok {
		t.Fatalf("expected ExitEvent, got %T", ev2)
	}
	if ex2.Reason != "server exited" {
		t.Errorf("Reason: got %q, want %q", ex2.Reason, "server exited")
	}
}

func TestParseEvent_Begin(t *testing.T) {
	ev, err := ParseEvent("%begin 1234567890 42 0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	b, ok := ev.(BeginEvent)
	if !ok {
		t.Fatalf("expected BeginEvent, got %T", ev)
	}
	if b.Time != 1234567890 {
		t.Errorf("Time: got %d, want %d", b.Time, int64(1234567890))
	}
	if b.CmdNumber != 42 {
		t.Errorf("CmdNumber: got %d, want %d", b.CmdNumber, 42)
	}
	if b.Flags != 0 {
		t.Errorf("Flags: got %d, want %d", b.Flags, 0)
	}
}

func TestParseEvent_End(t *testing.T) {
	ev, err := ParseEvent("%end 1234567890 42 0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	e, ok := ev.(EndEvent)
	if !ok {
		t.Fatalf("expected EndEvent, got %T", ev)
	}
	if e.Time != 1234567890 {
		t.Errorf("Time: got %d, want %d", e.Time, int64(1234567890))
	}
	if e.CmdNumber != 42 {
		t.Errorf("CmdNumber: got %d, want %d", e.CmdNumber, 42)
	}
	if e.Flags != 0 {
		t.Errorf("Flags: got %d, want %d", e.Flags, 0)
	}
}

func TestParseEvent_Error(t *testing.T) {
	ev, err := ParseEvent("%error 1234567890 42 1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	e, ok := ev.(ErrorEvent)
	if !ok {
		t.Fatalf("expected ErrorEvent, got %T", ev)
	}
	if e.Time != 1234567890 {
		t.Errorf("Time: got %d, want %d", e.Time, int64(1234567890))
	}
	if e.CmdNumber != 42 {
		t.Errorf("CmdNumber: got %d, want %d", e.CmdNumber, 42)
	}
	if e.Flags != 1 {
		t.Errorf("Flags: got %d, want %d", e.Flags, 1)
	}
}

func TestUnescapeOctal(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  []byte
	}{
		{"empty string", "", nil},
		{"no escapes", "hello", []byte("hello")},
		{"newline", `hello\012world`, []byte("hello\nworld")},
		{"backslash", `path\134name`, []byte("path\\name")},
		{"carriage return", `line\015end`, []byte("line\rend")},
		{"escape sequence", `\033[31m`, []byte("\033[31m")},
		{"multiple escapes", `a\012b\012c`, []byte("a\nb\nc")},
		{"backslash at end", `hello\`, []byte(`hello\`)},
		{"backslash non-octal", `hello\xyz`, []byte(`hello\xyz`)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := unescapeOctal(tc.input)
			if !bytes.Equal(got, tc.want) {
				t.Errorf("unescapeOctal(%q): got %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestParseEvent_NotAnEvent(t *testing.T) {
	_, err := ParseEvent("not-an-event line")
	if err == nil {
		t.Fatal("expected error for non-% line, got nil")
	}
}

func TestParseEvent_UnknownEvent(t *testing.T) {
	ev, err := ParseEvent("%future-event arg1 arg2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	unk, ok := ev.(UnknownEvent)
	if !ok {
		t.Fatalf("expected UnknownEvent, got %T", ev)
	}
	if unk.Name != "future-event" {
		t.Errorf("Name: got %q, want %q", unk.Name, "future-event")
	}
	if unk.Args != "arg1 arg2" {
		t.Errorf("Args: got %q, want %q", unk.Args, "arg1 arg2")
	}
}

func TestEventReader_Notifications(t *testing.T) {
	input := strings.Join([]string{
		"%session-changed $1 my-session",
		"%window-add @1",
		"%output %0 hello",
		"%layout-change @1 abc,80x24,0,0,0 abc,80x24,0,0,0 *",
		"",
	}, "\n")
	r := NewEventReader(bufio.NewReader(strings.NewReader(input)))

	// Event 1: session-changed
	ev, err := r.ReadEvent()
	if err != nil {
		t.Fatalf("event 1: unexpected error: %v", err)
	}
	if _, ok := ev.(SessionChangedEvent); !ok {
		t.Fatalf("event 1: expected SessionChangedEvent, got %T", ev)
	}

	// Event 2: window-add
	ev, err = r.ReadEvent()
	if err != nil {
		t.Fatalf("event 2: unexpected error: %v", err)
	}
	if _, ok := ev.(WindowAddEvent); !ok {
		t.Fatalf("event 2: expected WindowAddEvent, got %T", ev)
	}

	// Event 3: output
	ev, err = r.ReadEvent()
	if err != nil {
		t.Fatalf("event 3: unexpected error: %v", err)
	}
	if _, ok := ev.(OutputEvent); !ok {
		t.Fatalf("event 3: expected OutputEvent, got %T", ev)
	}

	// Event 4: layout-change
	ev, err = r.ReadEvent()
	if err != nil {
		t.Fatalf("event 4: unexpected error: %v", err)
	}
	if _, ok := ev.(LayoutChangeEvent); !ok {
		t.Fatalf("event 4: expected LayoutChangeEvent, got %T", ev)
	}

	// EOF
	_, err = r.ReadEvent()
	if err != io.EOF {
		t.Fatalf("expected io.EOF, got %v", err)
	}
}

func TestEventReader_CommandBlock(t *testing.T) {
	input := strings.Join([]string{
		"%begin 1234567890 1 0",
		"line one",
		"line two",
		"%end 1234567890 1 0",
		"%window-add @2",
		"",
	}, "\n")
	r := NewEventReader(bufio.NewReader(strings.NewReader(input)))

	// Event 1: CommandResultEvent from the begin/end block
	ev, err := r.ReadEvent()
	if err != nil {
		t.Fatalf("event 1: unexpected error: %v", err)
	}
	cr, ok := ev.(CommandResultEvent)
	if !ok {
		t.Fatalf("event 1: expected CommandResultEvent, got %T", ev)
	}
	if !cr.Success {
		t.Errorf("expected Success=true, got false")
	}
	if cr.CmdNumber != 1 {
		t.Errorf("CmdNumber: got %d, want 1", cr.CmdNumber)
	}
	if len(cr.Lines) != 2 {
		t.Fatalf("Lines: got %d lines, want 2", len(cr.Lines))
	}
	if cr.Lines[0] != "line one" {
		t.Errorf("Lines[0]: got %q, want %q", cr.Lines[0], "line one")
	}
	if cr.Lines[1] != "line two" {
		t.Errorf("Lines[1]: got %q, want %q", cr.Lines[1], "line two")
	}

	// Event 2: window-add notification after the block
	ev, err = r.ReadEvent()
	if err != nil {
		t.Fatalf("event 2: unexpected error: %v", err)
	}
	if _, ok := ev.(WindowAddEvent); !ok {
		t.Fatalf("event 2: expected WindowAddEvent, got %T", ev)
	}
}

func TestEventReader_CommandError(t *testing.T) {
	input := strings.Join([]string{
		"%begin 1234567890 2 0",
		"error line",
		"%error 1234567890 2 0",
		"",
	}, "\n")
	r := NewEventReader(bufio.NewReader(strings.NewReader(input)))

	ev, err := r.ReadEvent()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	cr, ok := ev.(CommandResultEvent)
	if !ok {
		t.Fatalf("expected CommandResultEvent, got %T", ev)
	}
	if cr.Success {
		t.Errorf("expected Success=false, got true")
	}
	if cr.CmdNumber != 2 {
		t.Errorf("CmdNumber: got %d, want 2", cr.CmdNumber)
	}
	if len(cr.Lines) != 1 {
		t.Fatalf("Lines: got %d lines, want 1", len(cr.Lines))
	}
	if cr.Lines[0] != "error line" {
		t.Errorf("Lines[0]: got %q, want %q", cr.Lines[0], "error line")
	}
}

func TestController_EventDispatch(t *testing.T) {
	pr, pw := io.Pipe()
	defer pr.Close()

	events := make(chan Event, 16)
	ctrl := NewController(ControllerConfig{
		Reader: pr,
		Writer: io.Discard,
		Events: events,
	})

	// Run controller in background
	done := make(chan error, 1)
	go func() {
		done <- ctrl.Run()
	}()

	// Write 4 events
	lines := strings.Join([]string{
		"%session-changed $1 dev",
		"%window-add @1",
		"%window-renamed @1 editor",
		"%layout-change @1 abc,80x24,0,0,0 abc,80x24,0,0,0 *",
		"",
	}, "\n")
	_, err := pw.Write([]byte(lines))
	if err != nil {
		t.Fatalf("write error: %v", err)
	}
	pw.Close()

	// Collect events with timeout
	var collected []Event
	timeout := time.After(2 * time.Second)
loop:
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				break loop
			}
			collected = append(collected, ev)
		case <-timeout:
			t.Fatal("timed out waiting for events")
		}
	}

	// Wait for Run() to finish
	if runErr := <-done; runErr != nil {
		t.Fatalf("Run() returned error: %v", runErr)
	}

	if len(collected) != 4 {
		t.Fatalf("expected 4 events, got %d", len(collected))
	}

	// Verify state was updated
	state := ctrl.State()
	if state.ActiveSessionID != "$1" {
		t.Errorf("ActiveSessionID: got %q, want %q", state.ActiveSessionID, "$1")
	}
	sess := state.FindSession("$1")
	if sess == nil {
		t.Fatal("session $1 not found")
	}
	if sess.Name != "dev" {
		t.Errorf("session name: got %q, want %q", sess.Name, "dev")
	}
	win := state.FindWindow("@1")
	if win == nil {
		t.Fatal("window @1 not found")
	}
	if win.Name != "editor" {
		t.Errorf("window name: got %q, want %q", win.Name, "editor")
	}
}