package sessiond

import (
	"bytes"
	"os"
	"sync"
	"testing"
	"time"
)

// waitFor polls cond until it returns true or the deadline elapses.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return cond()
}

func TestPaneEchoThenExit(t *testing.T) {
	var (
		mu            sync.Mutex
		exited        bool
		exitedID      int
		exitedCode    int
		exitedRuntime int64
	)
	onExit := func(localID int, exitCode int, runtimeMilliseconds int64) {
		mu.Lock()
		exited = true
		exitedID = localID
		exitedCode = exitCode
		exitedRuntime = runtimeMilliseconds
		mu.Unlock()
	}
	p, err := NewPane(1, []string{"echo", "hello-pane"}, 80, 24, nil, nil, onExit, nil, "")
	if err != nil {
		t.Fatalf("NewPane: %v", err)
	}
	ok := waitFor(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return exited
	})
	if !ok {
		t.Fatal("onExit was never called")
	}
	mu.Lock()
	gotID, gotCode, gotRuntime := exitedID, exitedCode, exitedRuntime
	mu.Unlock()
	if gotID != 1 {
		t.Fatalf("onExit localID = %d, want 1", gotID)
	}
	if gotCode != 0 {
		t.Fatalf("onExit exitCode = %d, want 0 (echo succeeds)", gotCode)
	}
	if gotRuntime < 0 {
		t.Fatalf("onExit runtimeMilliseconds = %d, want >= 0", gotRuntime)
	}
	if !bytes.Contains(p.Replay(), []byte("hello-pane")) {
		t.Fatalf("Replay = %q, want to contain hello-pane", p.Replay())
	}
}

func TestPaneInputIsEchoed(t *testing.T) {
	var (
		mu  sync.Mutex
		got []byte
	)
	onData := func(localID int, data []byte) {
		mu.Lock()
		got = append(got, data...)
		mu.Unlock()
	}
	p, err := NewPane(2, []string{"cat"}, 80, 24, nil, onData, nil, nil, "")
	if err != nil {
		t.Fatalf("NewPane: %v", err)
	}
	defer p.Close()
	if _, err := p.Write([]byte("ping\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	ok := waitFor(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return bytes.Contains(got, []byte("ping"))
	})
	if !ok {
		mu.Lock()
		defer mu.Unlock()
		t.Fatalf("onData never saw echoed input, got %q", got)
	}
}

func TestPaneResizeUpdatesInfo(t *testing.T) {
	p, err := NewPane(3, []string{"cat"}, 80, 24, nil, nil, nil, nil, "")
	if err != nil {
		t.Fatalf("NewPane: %v", err)
	}
	defer p.Close()
	if err := p.Resize(100, 30); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	info := p.Info()
	if info.Cols != 100 || info.Rows != 30 {
		t.Fatalf("Info = %+v, want Cols=100 Rows=30", info)
	}
	if info.PaneID != 3 {
		t.Fatalf("Info.PaneID = %d, want 3", info.PaneID)
	}
}

func TestPaneDefaultArgvUsesShell(t *testing.T) {
	p, err := NewPane(4, nil, 80, 24, nil, nil, nil, nil, "")
	if err != nil {
		t.Fatalf("NewPane with nil argv: %v", err)
	}
	p.Close()
}

func TestPaneEnvAndCwd(t *testing.T) {
	home := os.Getenv("HOME")
	if home == "" {
		t.Skip("HOME unset")
	}
	var (
		mu  sync.Mutex
		got []byte
	)
	onData := func(localID int, data []byte) {
		mu.Lock()
		got = append(got, data...)
		mu.Unlock()
	}
	p, err := NewPane(5, []string{"sh", "-c", "echo TERM=$TERM; echo PWD=$PWD"}, 80, 24, nil, onData, nil, nil, "")
	if err != nil {
		t.Fatalf("NewPane: %v", err)
	}
	defer p.Close()
	ok := waitFor(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return bytes.Contains(got, []byte("TERM=xterm-256color")) &&
			bytes.Contains(got, []byte("PWD="+home))
	})
	if !ok {
		mu.Lock()
		defer mu.Unlock()
		t.Fatalf("env/cwd not reflected, got %q (HOME=%q)", got, home)
	}
}

func TestPaneTitleFieldIsSettable(t *testing.T) {
	p, err := NewPane(6, []string{"cat"}, 80, 24, nil, nil, nil, nil, "")
	if err != nil {
		t.Fatalf("NewPane: %v", err)
	}
	defer p.Close()
	p.Title = "my-title"
	if got := p.Info().Title; got != "my-title" {
		t.Fatalf("Info().Title = %q, want my-title", got)
	}
}

// TestNewBrowserPane_SurfaceKind, TestNewBrowserPane_NilBuf, and
// TestNewBrowserPane_Info lived here. They were removed when muxterm dropped
// browser pane support: NewBrowserPane and Pane.SurfaceKind no longer exist.
