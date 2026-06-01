package tmux

import (
	"bytes"
	"testing"
)

func TestCommandSendKeys(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.SendKeys("%0", "ls -la"); err != nil {
		t.Fatalf("SendKeys returned error: %v", err)
	}

	got := buf.String()
	want := "send-keys -t %0 -- ls -la\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandSendKeysLiteral(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	// \x1b[A is the escape sequence for arrow up
	data := []byte{0x1b, 0x5b, 0x41}
	if err := cw.SendKeysLiteral("%0", data); err != nil {
		t.Fatalf("SendKeysLiteral returned error: %v", err)
	}

	got := buf.String()
	want := "send-keys -t %0 -H 1b 5b 41\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandSelectWindow(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.SelectWindow("@1"); err != nil {
		t.Fatalf("SelectWindow returned error: %v", err)
	}

	got := buf.String()
	want := "select-window -t @1\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandSelectPane(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.SelectPane("%0"); err != nil {
		t.Fatalf("SelectPane returned error: %v", err)
	}

	got := buf.String()
	want := "select-pane -t %0\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandSplitWindow(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.SplitWindow("%0", true); err != nil {
		t.Fatalf("SplitWindow returned error: %v", err)
	}

	got := buf.String()
	want := "split-window -h -t %0\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandSplitWindowVertical(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.SplitWindow("%0", false); err != nil {
		t.Fatalf("SplitWindow returned error: %v", err)
	}

	got := buf.String()
	want := "split-window -v -t %0\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandResizePaneRelative(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.ResizePaneRelative("%0", "R", 5); err != nil {
		t.Fatalf("ResizePaneRelative returned error: %v", err)
	}

	got := buf.String()
	want := "resize-pane -R -t \"%0\" 5\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandNewWindow(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.NewWindow(""); err != nil {
		t.Fatalf("NewWindow returned error: %v", err)
	}

	got := buf.String()
	want := "new-window\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandNewWindowWithName(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.NewWindow("editor"); err != nil {
		t.Fatalf("NewWindow returned error: %v", err)
	}

	got := buf.String()
	want := "new-window -n editor\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandClosePane(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.ClosePane("%0"); err != nil {
		t.Fatalf("ClosePane returned error: %v", err)
	}

	got := buf.String()
	want := "kill-pane -t %0\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandRenameWindow(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.RenameWindow("@1", "mywin"); err != nil {
		t.Fatalf("RenameWindow returned error: %v", err)
	}

	got := buf.String()
	want := "rename-window -t @1 mywin\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandCreateSession(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.CreateSession("work"); err != nil {
		t.Fatalf("CreateSession returned error: %v", err)
	}

	got := buf.String()
	want := "new-session -d -s work\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandListWindows(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.ListWindows(); err != nil {
		t.Fatalf("ListWindows returned error: %v", err)
	}

	got := buf.String()
	want := "list-windows -F '#{window_id} #{window_name} #{window_layout} #{window_active}'\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandListPanes(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.ListPanes(); err != nil {
		t.Fatalf("ListPanes returned error: %v", err)
	}

	got := buf.String()
	want := "list-panes -s -F '#{pane_id} #{pane_width} #{pane_height} #{pane_active}'\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}