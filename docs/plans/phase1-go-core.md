# Phase 1: Go Core — tmux Control Mode Engine

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Build the Go backend that connects to tmux via control mode, parses events, maintains state, and sends commands.

**Architecture:** A single `internal/tmux/` package connects to `tmux -CC attach`, reads the structured event stream line-by-line, parses notifications into typed Go structs, updates an in-memory `TmuxState` model, and sends commands by writing to tmux's stdin. No external dependencies — stdlib only.

**Tech Stack:** Go 1.24, standard library (`os/exec`, `bufio`, `encoding/json`, `sync`), tmux 3.5a control mode

**Verification approach:** After each task, run `go test ./...` AND `go build ./...`. For the final integration test, connect to a real tmux session. Do not trust unit tests alone — verify the binary actually works.

---

### Task 1: Scaffold Go Module

**Files:**
- Create: `go.mod`
- Create: `cmd/muxterm/main.go`
- Create: `Makefile`

**Step 1: Create go.mod**

Create `go.mod`:

```go
module github.com/user/muxterm

go 1.24
```

**Step 2: Create directory structure**

```bash
mkdir -p cmd/muxterm internal/tmux
```

**Step 3: Create main.go stub**

Create `cmd/muxterm/main.go`:

```go
package main

import (
	"fmt"
	"os"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "muxterm: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	fmt.Println("muxterm - web-native tmux client")
	return nil
}
```

**Step 4: Create Makefile**

Create `Makefile`:

```makefile
.PHONY: build test clean

build:
	go build -o bin/muxterm ./cmd/muxterm

test:
	go test -v ./...

clean:
	rm -rf bin/
```

**Step 5: Verify the scaffold builds**

Run: `go build ./... && go vet ./...`

Expected: no errors, clean exit.

Run: `./bin/muxterm` (after `make build`)

Expected: prints `muxterm - web-native tmux client`

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: scaffold Go module with cmd/muxterm and Makefile"
```

---

### Task 2: TmuxState Model

**Files:**
- Create: `internal/tmux/model.go`
- Create: `internal/tmux/model_test.go`

**Step 1: Write the test**

Create `internal/tmux/model_test.go`:

```go
package tmux

import (
	"encoding/json"
	"testing"
)

func TestTmuxState_JSONRoundTrip(t *testing.T) {
	state := &TmuxState{
		Sessions: []Session{
			{
				ID:   "$1",
				Name: "dev",
				Windows: []Window{
					{
						ID:     "@2",
						Name:   "vim",
						Layout: "c89d,200x50,0,0{100x50,0,0,3,99x50,101,0,4}",
						Active: true,
						Panes: []Pane{
							{ID: "%3", Width: 100, Height: 50, Active: true},
							{ID: "%4", Width: 99, Height: 50, Active: false},
						},
					},
				},
			},
		},
		ActiveSessionID: "$1",
	}

	data, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var got TmuxState
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if got.ActiveSessionID != "$1" {
		t.Errorf("ActiveSessionID = %q, want %q", got.ActiveSessionID, "$1")
	}
	if len(got.Sessions) != 1 {
		t.Fatalf("len(Sessions) = %d, want 1", len(got.Sessions))
	}
	s := got.Sessions[0]
	if s.Name != "dev" {
		t.Errorf("session name = %q, want %q", s.Name, "dev")
	}
	if len(s.Windows) != 1 {
		t.Fatalf("len(Windows) = %d, want 1", len(s.Windows))
	}
	w := s.Windows[0]
	if w.ID != "@2" || w.Name != "vim" || !w.Active {
		t.Errorf("window = %+v", w)
	}
	if len(w.Panes) != 2 {
		t.Fatalf("len(Panes) = %d, want 2", len(w.Panes))
	}
	if w.Panes[0].ID != "%3" || w.Panes[0].Width != 100 {
		t.Errorf("pane[0] = %+v", w.Panes[0])
	}
}

func TestTmuxState_FindWindow(t *testing.T) {
	state := &TmuxState{
		Sessions: []Session{
			{
				ID:   "$1",
				Name: "dev",
				Windows: []Window{
					{ID: "@2", Name: "vim"},
					{ID: "@3", Name: "build"},
				},
			},
		},
	}

	w := state.FindWindow("@3")
	if w == nil {
		t.Fatal("FindWindow(@3) returned nil")
	}
	if w.Name != "build" {
		t.Errorf("Name = %q, want %q", w.Name, "build")
	}

	if state.FindWindow("@99") != nil {
		t.Error("FindWindow(@99) should return nil")
	}
}

func TestTmuxState_FindPane(t *testing.T) {
	state := &TmuxState{
		Sessions: []Session{
			{
				ID: "$1",
				Windows: []Window{
					{
						ID:    "@2",
						Panes: []Pane{{ID: "%3"}, {ID: "%4"}},
					},
				},
			},
		},
	}

	p := state.FindPane("%4")
	if p == nil {
		t.Fatal("FindPane(%4) returned nil")
	}
	if p.ID != "%4" {
		t.Errorf("ID = %q, want %%4", p.ID)
	}
}

func TestTmuxState_FindSession(t *testing.T) {
	state := &TmuxState{
		Sessions: []Session{
			{ID: "$1", Name: "dev"},
			{ID: "$2", Name: "test"},
		},
	}

	s := state.FindSession("$2")
	if s == nil {
		t.Fatal("FindSession($2) returned nil")
	}
	if s.Name != "test" {
		t.Errorf("Name = %q, want %q", s.Name, "test")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run TestTmuxState`

Expected: compilation error — `TmuxState` not defined.

**Step 3: Write the implementation**

Create `internal/tmux/model.go`:

```go
package tmux

import "sync"

// TmuxState is the in-memory representation of tmux server state.
// It is the source of truth for what the browser renders.
type TmuxState struct {
	mu              sync.RWMutex `json:"-"`
	Sessions        []Session    `json:"sessions"`
	ActiveSessionID string       `json:"activeSessionId"`
}

// Session represents a tmux session.
type Session struct {
	ID      string   `json:"id"`   // $N format
	Name    string   `json:"name"`
	Windows []Window `json:"windows"`
}

// Window represents a tmux window (rendered as a tab in the browser).
type Window struct {
	ID     string `json:"id"`     // @N format
	Name   string `json:"name"`
	Layout string `json:"layout"` // tmux layout string
	Active bool   `json:"active"`
	Panes  []Pane `json:"panes"`
}

// Pane represents a tmux pane (rendered as a ghostty-web canvas in the browser).
type Pane struct {
	ID     string `json:"id"` // %N format
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Active bool   `json:"active"`
}

// FindSession returns a pointer to the session with the given ID, or nil.
func (s *TmuxState) FindSession(id string) *Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range s.Sessions {
		if s.Sessions[i].ID == id {
			return &s.Sessions[i]
		}
	}
	return nil
}

// FindWindow returns a pointer to the window with the given ID across all sessions, or nil.
func (s *TmuxState) FindWindow(id string) *Window {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range s.Sessions {
		for j := range s.Sessions[i].Windows {
			if s.Sessions[i].Windows[j].ID == id {
				return &s.Sessions[i].Windows[j]
			}
		}
	}
	return nil
}

// FindPane returns a pointer to the pane with the given ID across all windows, or nil.
func (s *TmuxState) FindPane(id string) *Pane {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range s.Sessions {
		for j := range s.Sessions[i].Windows {
			for k := range s.Sessions[i].Windows[j].Panes {
				if s.Sessions[i].Windows[j].Panes[k].ID == id {
					return &s.Sessions[i].Windows[j].Panes[k]
				}
			}
		}
	}
	return nil
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run TestTmuxState`

Expected: all 4 tests PASS.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add TmuxState model with Session, Window, Pane structs"
```

---

### Task 3: Layout String Parser

**Files:**
- Create: `internal/tmux/layout.go`
- Create: `internal/tmux/layout_test.go`

**Context:** tmux layout strings encode the pane arrangement. Format from actual tmux 3.5a output:

```
Single pane:     5686,200x50,0,0,55
Horizontal:      c89d,200x50,0,0{100x50,0,0,55,99x50,101,0,56}
Nested:          e759,200x50,0,0{100x50,0,0,55,99x50,101,0[99x25,101,0,56,99x24,101,26,57]}
```

Structure: `checksum,rootNode` where each node is `WxH,X,Y,paneID` (leaf), `WxH,X,Y{children}` (horizontal split), or `WxH,X,Y[children]` (vertical split). Pane IDs in layout strings are bare numbers (no `%` prefix). `{` means children arranged left-to-right; `[` means children arranged top-to-bottom.

**Step 1: Write the tests**

Create `internal/tmux/layout_test.go`:

```go
package tmux

import (
	"testing"
)

func TestParseLayout_SinglePane(t *testing.T) {
	// Actual tmux output for a single 200x50 pane, pane ID 55
	node, err := ParseLayout("5686,200x50,0,0,55")
	if err != nil {
		t.Fatalf("ParseLayout: %v", err)
	}
	if node.Type != PaneNode {
		t.Fatalf("Type = %v, want PaneNode", node.Type)
	}
	if node.Width != 200 || node.Height != 50 {
		t.Errorf("size = %dx%d, want 200x50", node.Width, node.Height)
	}
	if node.XOff != 0 || node.YOff != 0 {
		t.Errorf("offset = %d,%d, want 0,0", node.XOff, node.YOff)
	}
	if node.PaneID != 55 {
		t.Errorf("PaneID = %d, want 55", node.PaneID)
	}
}

func TestParseLayout_HorizontalSplit(t *testing.T) {
	// Two panes side by side: left=100x50 (pane 55), right=99x50 (pane 56)
	node, err := ParseLayout("c89d,200x50,0,0{100x50,0,0,55,99x50,101,0,56}")
	if err != nil {
		t.Fatalf("ParseLayout: %v", err)
	}
	if node.Type != HSplit {
		t.Fatalf("Type = %v, want HSplit", node.Type)
	}
	if len(node.Children) != 2 {
		t.Fatalf("len(Children) = %d, want 2", len(node.Children))
	}

	left := node.Children[0]
	if left.Type != PaneNode || left.PaneID != 55 || left.Width != 100 {
		t.Errorf("left = %+v", left)
	}
	right := node.Children[1]
	if right.Type != PaneNode || right.PaneID != 56 || right.Width != 99 {
		t.Errorf("right = %+v", right)
	}
}

func TestParseLayout_VerticalSplit(t *testing.T) {
	// Two panes stacked: top and bottom
	node, err := ParseLayout("0d8b,200x50,0,0[200x25,0,0,46,200x24,0,26,47]")
	if err != nil {
		t.Fatalf("ParseLayout: %v", err)
	}
	if node.Type != VSplit {
		t.Fatalf("Type = %v, want VSplit", node.Type)
	}
	if len(node.Children) != 2 {
		t.Fatalf("len(Children) = %d, want 2", len(node.Children))
	}

	top := node.Children[0]
	if top.PaneID != 46 || top.Height != 25 || top.YOff != 0 {
		t.Errorf("top = %+v", top)
	}
	bottom := node.Children[1]
	if bottom.PaneID != 47 || bottom.Height != 24 || bottom.YOff != 26 {
		t.Errorf("bottom = %+v", bottom)
	}
}

func TestParseLayout_NestedSplits(t *testing.T) {
	// Left pane + right side split vertically into 2:
	// {left, [top-right, bottom-right]}
	node, err := ParseLayout("e759,200x50,0,0{100x50,0,0,55,99x50,101,0[99x25,101,0,56,99x24,101,26,57]}")
	if err != nil {
		t.Fatalf("ParseLayout: %v", err)
	}
	if node.Type != HSplit {
		t.Fatalf("root Type = %v, want HSplit", node.Type)
	}
	if len(node.Children) != 2 {
		t.Fatalf("root children = %d, want 2", len(node.Children))
	}

	// Left child is a leaf pane
	left := node.Children[0]
	if left.Type != PaneNode || left.PaneID != 55 {
		t.Errorf("left = %+v", left)
	}

	// Right child is a vertical split
	right := node.Children[1]
	if right.Type != VSplit {
		t.Fatalf("right Type = %v, want VSplit", right.Type)
	}
	if len(right.Children) != 2 {
		t.Fatalf("right children = %d, want 2", len(right.Children))
	}
	if right.Children[0].PaneID != 56 {
		t.Errorf("top-right pane = %d, want 56", right.Children[0].PaneID)
	}
	if right.Children[1].PaneID != 57 {
		t.Errorf("bottom-right pane = %d, want 57", right.Children[1].PaneID)
	}
}

func TestParseLayout_CollectPaneIDs(t *testing.T) {
	node, err := ParseLayout("e759,200x50,0,0{100x50,0,0,55,99x50,101,0[99x25,101,0,56,99x24,101,26,57]}")
	if err != nil {
		t.Fatal(err)
	}

	ids := node.PaneIDs()
	if len(ids) != 3 {
		t.Fatalf("len(PaneIDs) = %d, want 3", len(ids))
	}
	expected := []int{55, 56, 57}
	for i, id := range ids {
		if id != expected[i] {
			t.Errorf("PaneIDs[%d] = %d, want %d", i, id, expected[i])
		}
	}
}

func TestParseLayout_InvalidInput(t *testing.T) {
	cases := []string{
		"",
		"not-a-layout",
		"xxxx,abc",
		"xxxx,200x50,0,0",  // no pane ID or children
	}
	for _, input := range cases {
		_, err := ParseLayout(input)
		if err == nil {
			t.Errorf("ParseLayout(%q) should have returned error", input)
		}
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run TestParseLayout`

Expected: compilation error — `ParseLayout`, `PaneNode`, etc. not defined.

**Step 3: Write the implementation**

Create `internal/tmux/layout.go`:

```go
package tmux

import (
	"fmt"
	"strings"
)

// NodeType describes whether a layout node is a leaf pane or a split container.
type NodeType int

const (
	PaneNode NodeType = iota // Leaf: a single pane
	HSplit                   // Horizontal split: children arranged left to right
	VSplit                   // Vertical split: children arranged top to bottom
)

func (n NodeType) String() string {
	switch n {
	case PaneNode:
		return "pane"
	case HSplit:
		return "hsplit"
	case VSplit:
		return "vsplit"
	default:
		return "unknown"
	}
}

// LayoutNode represents one node in the parsed tmux layout tree.
type LayoutNode struct {
	Type     NodeType
	Width    int
	Height   int
	XOff     int
	YOff     int
	PaneID   int           // Only set for PaneNode
	Children []*LayoutNode // Only set for HSplit/VSplit
}

// PaneIDs returns all pane IDs in the layout tree in left-to-right, top-to-bottom order.
func (n *LayoutNode) PaneIDs() []int {
	if n.Type == PaneNode {
		return []int{n.PaneID}
	}
	var ids []int
	for _, child := range n.Children {
		ids = append(ids, child.PaneIDs()...)
	}
	return ids
}

// ParseLayout parses a tmux layout string into a tree of LayoutNodes.
//
// Format: "checksum,WxH,X,Y,paneID" (leaf) or "checksum,WxH,X,Y{children}" / "checksum,WxH,X,Y[children]" (split).
// Example: "c89d,200x50,0,0{100x50,0,0,55,99x50,101,0,56}"
func ParseLayout(s string) (*LayoutNode, error) {
	if s == "" {
		return nil, fmt.Errorf("empty layout string")
	}
	// Strip the checksum prefix (everything before and including the first comma)
	idx := strings.IndexByte(s, ',')
	if idx == -1 {
		return nil, fmt.Errorf("no checksum separator in layout %q", s)
	}
	p := &layoutParser{input: s, pos: idx + 1}
	node, err := p.parseNode()
	if err != nil {
		return nil, fmt.Errorf("parse layout %q: %w", s, err)
	}
	return node, nil
}

type layoutParser struct {
	input string
	pos   int
}

func (p *layoutParser) parseNode() (*LayoutNode, error) {
	w, err := p.parseInt()
	if err != nil {
		return nil, fmt.Errorf("width: %w", err)
	}
	if err := p.expectByte('x'); err != nil {
		return nil, err
	}
	h, err := p.parseInt()
	if err != nil {
		return nil, fmt.Errorf("height: %w", err)
	}
	if err := p.expectByte(','); err != nil {
		return nil, err
	}
	x, err := p.parseInt()
	if err != nil {
		return nil, fmt.Errorf("x offset: %w", err)
	}
	if err := p.expectByte(','); err != nil {
		return nil, err
	}
	y, err := p.parseInt()
	if err != nil {
		return nil, fmt.Errorf("y offset: %w", err)
	}

	if p.pos >= len(p.input) {
		return nil, fmt.Errorf("unexpected end of input after dimensions")
	}

	ch := p.input[p.pos]
	switch ch {
	case '{':
		p.pos++ // consume {
		children, err := p.parseChildren()
		if err != nil {
			return nil, err
		}
		if err := p.expectByte('}'); err != nil {
			return nil, err
		}
		return &LayoutNode{Type: HSplit, Width: w, Height: h, XOff: x, YOff: y, Children: children}, nil

	case '[':
		p.pos++ // consume [
		children, err := p.parseChildren()
		if err != nil {
			return nil, err
		}
		if err := p.expectByte(']'); err != nil {
			return nil, err
		}
		return &LayoutNode{Type: VSplit, Width: w, Height: h, XOff: x, YOff: y, Children: children}, nil

	case ',':
		p.pos++ // consume ,
		paneID, err := p.parseInt()
		if err != nil {
			return nil, fmt.Errorf("pane ID: %w", err)
		}
		return &LayoutNode{Type: PaneNode, Width: w, Height: h, XOff: x, YOff: y, PaneID: paneID}, nil

	default:
		return nil, fmt.Errorf("unexpected char %q at pos %d", string(ch), p.pos)
	}
}

func (p *layoutParser) parseChildren() ([]*LayoutNode, error) {
	var children []*LayoutNode
	for {
		child, err := p.parseNode()
		if err != nil {
			return nil, err
		}
		children = append(children, child)
		// After a child, check if there's a separator comma before the next child.
		// The next child starts with a digit (WxH), so the comma between siblings
		// is followed by a digit.
		if p.pos >= len(p.input) {
			break
		}
		if p.input[p.pos] == '}' || p.input[p.pos] == ']' {
			break
		}
		if p.input[p.pos] == ',' {
			p.pos++ // consume separator between siblings
		}
	}
	return children, nil
}

func (p *layoutParser) parseInt() (int, error) {
	if p.pos >= len(p.input) {
		return 0, fmt.Errorf("unexpected end of input, expected integer")
	}
	start := p.pos
	for p.pos < len(p.input) && p.input[p.pos] >= '0' && p.input[p.pos] <= '9' {
		p.pos++
	}
	if p.pos == start {
		return 0, fmt.Errorf("expected integer at pos %d, got %q", p.pos, string(p.input[p.pos]))
	}
	n := 0
	for _, ch := range p.input[start:p.pos] {
		n = n*10 + int(ch-'0')
	}
	return n, nil
}

func (p *layoutParser) expectByte(expected byte) error {
	if p.pos >= len(p.input) {
		return fmt.Errorf("unexpected end of input, expected %q", string(expected))
	}
	if p.input[p.pos] != expected {
		return fmt.Errorf("expected %q at pos %d, got %q", string(expected), p.pos, string(p.input[p.pos]))
	}
	p.pos++
	return nil
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run TestParseLayout`

Expected: all 6 tests PASS.

**Step 5: Manually verify with real tmux layout strings**

Run this to get a real layout string and paste it into a quick test:

```bash
cd ~/workspace/muxterm
tmux kill-session -t plantest 2>/dev/null
tmux new-session -d -s plantest -x 80 -y 24
tmux split-window -h -t plantest
tmux list-windows -t plantest -F '#{window_layout}'
tmux kill-session -t plantest
```

Confirm the parser handles the output string without error.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add tmux layout string parser with recursive descent"
```

---

### Task 4: Event Types and Parser

**Files:**
- Create: `internal/tmux/control.go`
- Create: `internal/tmux/control_test.go`

**Context:** tmux control mode notifications are line-oriented. Each line starts with `%event-name` followed by space-separated arguments. The `%output` event's data uses octal escaping (`\012` for newline, `\134` for backslash). From tmux 3.5a man page, the key notifications are:

| Event | Format |
|-------|--------|
| `%output` | `%output %N data` (octal-escaped) |
| `%layout-change` | `%layout-change @W layout visible-layout flags` |
| `%window-add` | `%window-add @W` |
| `%window-close` | `%window-close @W` |
| `%window-renamed` | `%window-renamed @W name` |
| `%session-changed` | `%session-changed $S name` |
| `%session-window-changed` | `%session-window-changed $S @W` |
| `%session-renamed` | `%session-renamed name` |
| `%sessions-changed` | `%sessions-changed` |
| `%pane-mode-changed` | `%pane-mode-changed %N` |
| `%window-pane-changed` | `%window-pane-changed @W %N` |
| `%exit` | `%exit [reason]` |
| `%begin` | `%begin time cmd-number flags` |
| `%end` | `%end time cmd-number flags` |
| `%error` | `%error time cmd-number flags` |

**Step 1: Write the tests**

Create `internal/tmux/control_test.go`:

```go
package tmux

import (
	"testing"
)

func TestParseEvent_Output(t *testing.T) {
	ev, err := ParseEvent("%output %5 hello world")
	if err != nil {
		t.Fatal(err)
	}
	out, ok := ev.(*OutputEvent)
	if !ok {
		t.Fatalf("type = %T, want *OutputEvent", ev)
	}
	if out.PaneID != "%5" {
		t.Errorf("PaneID = %q, want %%5", out.PaneID)
	}
	if string(out.Data) != "hello world" {
		t.Errorf("Data = %q, want %q", out.Data, "hello world")
	}
}

func TestParseEvent_OutputOctalEscape(t *testing.T) {
	// \012 = newline (octal 012 = decimal 10)
	ev, err := ParseEvent(`%output %5 hello\012world`)
	if err != nil {
		t.Fatal(err)
	}
	out := ev.(*OutputEvent)
	if string(out.Data) != "hello\nworld" {
		t.Errorf("Data = %q, want %q", out.Data, "hello\nworld")
	}
}

func TestParseEvent_OutputBackslashEscape(t *testing.T) {
	// \134 = backslash (octal 134 = decimal 92)
	ev, err := ParseEvent(`%output %5 foo\134bar`)
	if err != nil {
		t.Fatal(err)
	}
	out := ev.(*OutputEvent)
	if string(out.Data) != "foo\\bar" {
		t.Errorf("Data = %q, want %q", out.Data, "foo\\bar")
	}
}

func TestParseEvent_LayoutChange(t *testing.T) {
	ev, err := ParseEvent("%layout-change @2 c89d,200x50,0,0{100x50,0,0,3,99x50,101,0,4} c89d,200x50,0,0{100x50,0,0,3,99x50,101,0,4} *")
	if err != nil {
		t.Fatal(err)
	}
	lc, ok := ev.(*LayoutChangeEvent)
	if !ok {
		t.Fatalf("type = %T, want *LayoutChangeEvent", ev)
	}
	if lc.WindowID != "@2" {
		t.Errorf("WindowID = %q, want @2", lc.WindowID)
	}
	if lc.Layout != "c89d,200x50,0,0{100x50,0,0,3,99x50,101,0,4}" {
		t.Errorf("Layout = %q", lc.Layout)
	}
}

func TestParseEvent_WindowAdd(t *testing.T) {
	ev, err := ParseEvent("%window-add @3")
	if err != nil {
		t.Fatal(err)
	}
	wa, ok := ev.(*WindowAddEvent)
	if !ok {
		t.Fatalf("type = %T, want *WindowAddEvent", ev)
	}
	if wa.WindowID != "@3" {
		t.Errorf("WindowID = %q, want @3", wa.WindowID)
	}
}

func TestParseEvent_WindowClose(t *testing.T) {
	ev, err := ParseEvent("%window-close @3")
	if err != nil {
		t.Fatal(err)
	}
	wc := ev.(*WindowCloseEvent)
	if wc.WindowID != "@3" {
		t.Errorf("WindowID = %q, want @3", wc.WindowID)
	}
}

func TestParseEvent_WindowRenamed(t *testing.T) {
	ev, err := ParseEvent("%window-renamed @3 vim")
	if err != nil {
		t.Fatal(err)
	}
	wr := ev.(*WindowRenamedEvent)
	if wr.WindowID != "@3" || wr.Name != "vim" {
		t.Errorf("got %+v", wr)
	}
}

func TestParseEvent_SessionChanged(t *testing.T) {
	ev, err := ParseEvent("%session-changed $1 dev")
	if err != nil {
		t.Fatal(err)
	}
	sc := ev.(*SessionChangedEvent)
	if sc.SessionID != "$1" || sc.Name != "dev" {
		t.Errorf("got %+v", sc)
	}
}

func TestParseEvent_SessionWindowChanged(t *testing.T) {
	ev, err := ParseEvent("%session-window-changed $1 @3")
	if err != nil {
		t.Fatal(err)
	}
	swc := ev.(*SessionWindowChangedEvent)
	if swc.SessionID != "$1" || swc.WindowID != "@3" {
		t.Errorf("got %+v", swc)
	}
}

func TestParseEvent_SessionRenamed(t *testing.T) {
	ev, err := ParseEvent("%session-renamed dev2")
	if err != nil {
		t.Fatal(err)
	}
	sr := ev.(*SessionRenamedEvent)
	if sr.Name != "dev2" {
		t.Errorf("Name = %q, want %q", sr.Name, "dev2")
	}
}

func TestParseEvent_SessionsChanged(t *testing.T) {
	ev, err := ParseEvent("%sessions-changed")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ev.(*SessionsChangedEvent); !ok {
		t.Fatalf("type = %T, want *SessionsChangedEvent", ev)
	}
}

func TestParseEvent_PaneModeChanged(t *testing.T) {
	ev, err := ParseEvent("%pane-mode-changed %5")
	if err != nil {
		t.Fatal(err)
	}
	pm := ev.(*PaneModeChangedEvent)
	if pm.PaneID != "%5" {
		t.Errorf("PaneID = %q, want %%5", pm.PaneID)
	}
}

func TestParseEvent_WindowPaneChanged(t *testing.T) {
	ev, err := ParseEvent("%window-pane-changed @2 %5")
	if err != nil {
		t.Fatal(err)
	}
	wpc := ev.(*WindowPaneChangedEvent)
	if wpc.WindowID != "@2" || wpc.PaneID != "%5" {
		t.Errorf("got %+v", wpc)
	}
}

func TestParseEvent_Exit(t *testing.T) {
	ev, err := ParseEvent("%exit")
	if err != nil {
		t.Fatal(err)
	}
	ex := ev.(*ExitEvent)
	if ex.Reason != "" {
		t.Errorf("Reason = %q, want empty", ex.Reason)
	}
}

func TestParseEvent_ExitWithReason(t *testing.T) {
	ev, err := ParseEvent("%exit server exited")
	if err != nil {
		t.Fatal(err)
	}
	ex := ev.(*ExitEvent)
	if ex.Reason != "server exited" {
		t.Errorf("Reason = %q, want %q", ex.Reason, "server exited")
	}
}

func TestParseEvent_Begin(t *testing.T) {
	ev, err := ParseEvent("%begin 1363006971 2 1")
	if err != nil {
		t.Fatal(err)
	}
	b := ev.(*BeginEvent)
	if b.Time != 1363006971 || b.CmdNumber != 2 || b.Flags != 1 {
		t.Errorf("got %+v", b)
	}
}

func TestParseEvent_End(t *testing.T) {
	ev, err := ParseEvent("%end 1363006971 2 1")
	if err != nil {
		t.Fatal(err)
	}
	e := ev.(*EndEvent)
	if e.Time != 1363006971 || e.CmdNumber != 2 {
		t.Errorf("got %+v", e)
	}
}

func TestParseEvent_Error(t *testing.T) {
	ev, err := ParseEvent("%error 1363006971 2 1")
	if err != nil {
		t.Fatal(err)
	}
	e := ev.(*ErrorEvent)
	if e.Time != 1363006971 || e.CmdNumber != 2 {
		t.Errorf("got %+v", e)
	}
}

func TestUnescapeOctal(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"hello", "hello"},
		{`hello\012world`, "hello\nworld"},
		{`\015\012`, "\r\n"},
		{`foo\134bar`, "foo\\bar"},
		{`\033[31m`, "\033[31m"},
		{"", ""},
		{`no escape here`, "no escape here"},
		{`end\012`, "end\n"},
		{`\012start`, "\nstart"},
	}
	for _, tt := range tests {
		got := unescapeOctal(tt.input)
		if string(got) != tt.want {
			t.Errorf("unescapeOctal(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestParseEvent_NotAnEvent(t *testing.T) {
	_, err := ParseEvent("not an event line")
	if err == nil {
		t.Error("expected error for non-event line")
	}
}

func TestParseEvent_UnknownEvent(t *testing.T) {
	ev, err := ParseEvent("%unknown-future-event arg1 arg2")
	if err != nil {
		t.Fatal(err)
	}
	u, ok := ev.(*UnknownEvent)
	if !ok {
		t.Fatalf("type = %T, want *UnknownEvent", ev)
	}
	if u.Name != "%unknown-future-event" {
		t.Errorf("Name = %q", u.Name)
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run "TestParseEvent|TestUnescapeOctal"`

Expected: compilation error — types and functions not defined.

**Step 3: Write the implementation**

Create `internal/tmux/control.go`:

```go
package tmux

import (
	"fmt"
	"strconv"
	"strings"
)

// Event is the interface implemented by all tmux control mode events.
type Event interface {
	eventMarker()
}

// OutputEvent represents terminal output from a pane.
type OutputEvent struct {
	PaneID string // %N format
	Data   []byte // unescaped terminal data
}

func (*OutputEvent) eventMarker() {}

// LayoutChangeEvent represents a window layout change.
type LayoutChangeEvent struct {
	WindowID      string // @N format
	Layout        string // tmux layout string
	VisibleLayout string
	Flags         string
}

func (*LayoutChangeEvent) eventMarker() {}

// WindowAddEvent represents a new window added to the session.
type WindowAddEvent struct {
	WindowID string
}

func (*WindowAddEvent) eventMarker() {}

// WindowCloseEvent represents a window being closed.
type WindowCloseEvent struct {
	WindowID string
}

func (*WindowCloseEvent) eventMarker() {}

// WindowRenamedEvent represents a window being renamed.
type WindowRenamedEvent struct {
	WindowID string
	Name     string
}

func (*WindowRenamedEvent) eventMarker() {}

// SessionChangedEvent represents the client attaching to a different session.
type SessionChangedEvent struct {
	SessionID string
	Name      string
}

func (*SessionChangedEvent) eventMarker() {}

// SessionWindowChangedEvent represents the active window changing in a session.
type SessionWindowChangedEvent struct {
	SessionID string
	WindowID  string
}

func (*SessionWindowChangedEvent) eventMarker() {}

// SessionRenamedEvent represents the current session being renamed.
type SessionRenamedEvent struct {
	Name string
}

func (*SessionRenamedEvent) eventMarker() {}

// SessionsChangedEvent represents a session being created or destroyed.
type SessionsChangedEvent struct{}

func (*SessionsChangedEvent) eventMarker() {}

// PaneModeChangedEvent represents a pane entering or leaving a mode (e.g. copy mode).
type PaneModeChangedEvent struct {
	PaneID string
}

func (*PaneModeChangedEvent) eventMarker() {}

// WindowPaneChangedEvent represents the active pane changing within a window.
type WindowPaneChangedEvent struct {
	WindowID string
	PaneID   string
}

func (*WindowPaneChangedEvent) eventMarker() {}

// ExitEvent represents the control mode client exiting.
type ExitEvent struct {
	Reason string
}

func (*ExitEvent) eventMarker() {}

// BeginEvent marks the start of a command response block.
type BeginEvent struct {
	Time      int64
	CmdNumber int
	Flags     int
}

func (*BeginEvent) eventMarker() {}

// EndEvent marks the successful end of a command response block.
type EndEvent struct {
	Time      int64
	CmdNumber int
	Flags     int
}

func (*EndEvent) eventMarker() {}

// ErrorEvent marks the failed end of a command response block.
type ErrorEvent struct {
	Time      int64
	CmdNumber int
	Flags     int
}

func (*ErrorEvent) eventMarker() {}

// UnknownEvent represents an event type we don't recognize.
// Forward-compatible: new tmux versions may add events.
type UnknownEvent struct {
	Name string
	Args string
}

func (*UnknownEvent) eventMarker() {}

// ParseEvent parses a single tmux control mode notification line into a typed Event.
func ParseEvent(line string) (Event, error) {
	if !strings.HasPrefix(line, "%") {
		return nil, fmt.Errorf("not a control mode event: %q", line)
	}

	name, args, _ := strings.Cut(line, " ")

	switch name {
	case "%output":
		return parseOutputEvent(args)
	case "%layout-change":
		return parseLayoutChangeEvent(args)
	case "%window-add":
		return &WindowAddEvent{WindowID: args}, nil
	case "%window-close":
		return &WindowCloseEvent{WindowID: args}, nil
	case "%window-renamed":
		id, rest, _ := strings.Cut(args, " ")
		return &WindowRenamedEvent{WindowID: id, Name: rest}, nil
	case "%session-changed":
		id, rest, _ := strings.Cut(args, " ")
		return &SessionChangedEvent{SessionID: id, Name: rest}, nil
	case "%session-window-changed":
		id, wid, _ := strings.Cut(args, " ")
		return &SessionWindowChangedEvent{SessionID: id, WindowID: wid}, nil
	case "%session-renamed":
		return &SessionRenamedEvent{Name: args}, nil
	case "%sessions-changed":
		return &SessionsChangedEvent{}, nil
	case "%pane-mode-changed":
		return &PaneModeChangedEvent{PaneID: args}, nil
	case "%window-pane-changed":
		wid, pid, _ := strings.Cut(args, " ")
		return &WindowPaneChangedEvent{WindowID: wid, PaneID: pid}, nil
	case "%exit":
		return &ExitEvent{Reason: args}, nil
	case "%begin":
		return parseBlockMarker(args, func(t int64, n, f int) Event {
			return &BeginEvent{Time: t, CmdNumber: n, Flags: f}
		})
	case "%end":
		return parseBlockMarker(args, func(t int64, n, f int) Event {
			return &EndEvent{Time: t, CmdNumber: n, Flags: f}
		})
	case "%error":
		return parseBlockMarker(args, func(t int64, n, f int) Event {
			return &ErrorEvent{Time: t, CmdNumber: n, Flags: f}
		})
	default:
		return &UnknownEvent{Name: name, Args: args}, nil
	}
}

func parseOutputEvent(args string) (*OutputEvent, error) {
	paneID, data, _ := strings.Cut(args, " ")
	return &OutputEvent{
		PaneID: paneID,
		Data:   unescapeOctal(data),
	}, nil
}

func parseLayoutChangeEvent(args string) (*LayoutChangeEvent, error) {
	// Format: window-id layout visible-layout flags
	fields := strings.SplitN(args, " ", 4)
	ev := &LayoutChangeEvent{WindowID: fields[0]}
	if len(fields) > 1 {
		ev.Layout = fields[1]
	}
	if len(fields) > 2 {
		ev.VisibleLayout = fields[2]
	}
	if len(fields) > 3 {
		ev.Flags = fields[3]
	}
	return ev, nil
}

func parseBlockMarker(args string, make_ func(int64, int, int) Event) (Event, error) {
	fields := strings.Fields(args)
	if len(fields) < 3 {
		return nil, fmt.Errorf("block marker needs 3 fields, got %d: %q", len(fields), args)
	}
	t, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("block marker time: %w", err)
	}
	n, err := strconv.Atoi(fields[1])
	if err != nil {
		return nil, fmt.Errorf("block marker cmd number: %w", err)
	}
	f, err := strconv.Atoi(fields[2])
	if err != nil {
		return nil, fmt.Errorf("block marker flags: %w", err)
	}
	return make_(t, n, f), nil
}

// unescapeOctal decodes tmux control mode's octal-escaped output data.
// Non-printable characters and backslash are encoded as \NNN (backslash + 3 octal digits).
func unescapeOctal(s string) []byte {
	if !strings.ContainsRune(s, '\\') {
		return []byte(s)
	}

	buf := make([]byte, 0, len(s))
	i := 0
	for i < len(s) {
		if s[i] == '\\' && i+3 < len(s) && isOctal(s[i+1]) && isOctal(s[i+2]) && isOctal(s[i+3]) {
			val := (s[i+1]-'0')*64 + (s[i+2]-'0')*8 + (s[i+3] - '0')
			buf = append(buf, val)
			i += 4
		} else {
			buf = append(buf, s[i])
			i++
		}
	}
	return buf
}

func isOctal(b byte) bool {
	return b >= '0' && b <= '7'
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run "TestParseEvent|TestUnescapeOctal"`

Expected: all 20 tests PASS.

**Step 5: Run all tests to check nothing is broken**

Run: `cd ~/workspace/muxterm && go test ./... -v`

Expected: all tests PASS (model + layout + event parser).

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add control mode event parser with all notification types"
```

---

### Task 5: State Mutations from Events

**Files:**
- Modify: `internal/tmux/model.go` (add Apply* methods)
- Modify: `internal/tmux/model_test.go` (add mutation tests)

**Step 1: Write the tests**

Add to `internal/tmux/model_test.go`:

```go
func TestTmuxState_ApplySessionChanged(t *testing.T) {
	state := &TmuxState{}

	state.ApplySessionChanged("$1", "dev")

	if state.ActiveSessionID != "$1" {
		t.Errorf("ActiveSessionID = %q, want $1", state.ActiveSessionID)
	}
	if len(state.Sessions) != 1 {
		t.Fatalf("len(Sessions) = %d, want 1", len(state.Sessions))
	}
	if state.Sessions[0].Name != "dev" {
		t.Errorf("Name = %q, want dev", state.Sessions[0].Name)
	}
}

func TestTmuxState_ApplySessionChanged_Existing(t *testing.T) {
	state := &TmuxState{
		Sessions: []Session{
			{ID: "$1", Name: "dev", Windows: []Window{{ID: "@1", Name: "bash"}}},
			{ID: "$2", Name: "test"},
		},
		ActiveSessionID: "$1",
	}

	state.ApplySessionChanged("$2", "test")

	if state.ActiveSessionID != "$2" {
		t.Errorf("ActiveSessionID = %q, want $2", state.ActiveSessionID)
	}
	// Should not duplicate sessions
	if len(state.Sessions) != 2 {
		t.Errorf("len(Sessions) = %d, want 2", len(state.Sessions))
	}
}

func TestTmuxState_ApplyWindowAdd(t *testing.T) {
	state := &TmuxState{
		Sessions:        []Session{{ID: "$1", Name: "dev"}},
		ActiveSessionID: "$1",
	}

	state.ApplyWindowAdd("@3")

	s := state.FindSession("$1")
	if len(s.Windows) != 1 {
		t.Fatalf("len(Windows) = %d, want 1", len(s.Windows))
	}
	if s.Windows[0].ID != "@3" {
		t.Errorf("WindowID = %q, want @3", s.Windows[0].ID)
	}
}

func TestTmuxState_ApplyWindowClose(t *testing.T) {
	state := &TmuxState{
		Sessions: []Session{
			{
				ID: "$1",
				Windows: []Window{
					{ID: "@2", Name: "vim"},
					{ID: "@3", Name: "build"},
				},
			},
		},
		ActiveSessionID: "$1",
	}

	state.ApplyWindowClose("@2")

	s := state.FindSession("$1")
	if len(s.Windows) != 1 {
		t.Fatalf("len(Windows) = %d, want 1", len(s.Windows))
	}
	if s.Windows[0].ID != "@3" {
		t.Errorf("remaining window = %q, want @3", s.Windows[0].ID)
	}
}

func TestTmuxState_ApplyWindowRenamed(t *testing.T) {
	state := &TmuxState{
		Sessions: []Session{
			{
				ID:      "$1",
				Windows: []Window{{ID: "@2", Name: "bash"}},
			},
		},
	}

	state.ApplyWindowRenamed("@2", "vim")

	w := state.FindWindow("@2")
	if w.Name != "vim" {
		t.Errorf("Name = %q, want vim", w.Name)
	}
}

func TestTmuxState_ApplyLayoutChange(t *testing.T) {
	state := &TmuxState{
		Sessions: []Session{
			{
				ID: "$1",
				Windows: []Window{
					{
						ID:     "@2",
						Layout: "old,80x24,0,0,1",
						Panes:  []Pane{{ID: "%1", Width: 80, Height: 24}},
					},
				},
			},
		},
	}

	state.ApplyLayoutChange("@2", "c89d,200x50,0,0{100x50,0,0,1,99x50,101,0,2}")

	w := state.FindWindow("@2")
	if w.Layout != "c89d,200x50,0,0{100x50,0,0,1,99x50,101,0,2}" {
		t.Errorf("Layout = %q", w.Layout)
	}
	// Should update pane list from layout
	if len(w.Panes) != 2 {
		t.Fatalf("len(Panes) = %d, want 2", len(w.Panes))
	}
	if w.Panes[0].ID != "%1" || w.Panes[0].Width != 100 {
		t.Errorf("pane[0] = %+v", w.Panes[0])
	}
	if w.Panes[1].ID != "%2" || w.Panes[1].Width != 99 {
		t.Errorf("pane[1] = %+v", w.Panes[1])
	}
}

func TestTmuxState_ApplySessionWindowChanged(t *testing.T) {
	state := &TmuxState{
		Sessions: []Session{
			{
				ID: "$1",
				Windows: []Window{
					{ID: "@2", Active: true},
					{ID: "@3", Active: false},
				},
			},
		},
	}

	state.ApplySessionWindowChanged("$1", "@3")

	s := state.FindSession("$1")
	for _, w := range s.Windows {
		if w.ID == "@2" && w.Active {
			t.Error("@2 should not be active")
		}
		if w.ID == "@3" && !w.Active {
			t.Error("@3 should be active")
		}
	}
}

func TestTmuxState_ApplyWindowPaneChanged(t *testing.T) {
	state := &TmuxState{
		Sessions: []Session{
			{
				ID: "$1",
				Windows: []Window{
					{
						ID: "@2",
						Panes: []Pane{
							{ID: "%3", Active: true},
							{ID: "%4", Active: false},
						},
					},
				},
			},
		},
	}

	state.ApplyWindowPaneChanged("@2", "%4")

	w := state.FindWindow("@2")
	for _, p := range w.Panes {
		if p.ID == "%3" && p.Active {
			t.Error("%3 should not be active")
		}
		if p.ID == "%4" && !p.Active {
			t.Error("%4 should be active")
		}
	}
}

func TestTmuxState_ApplySessionRenamed(t *testing.T) {
	state := &TmuxState{
		Sessions:        []Session{{ID: "$1", Name: "dev"}},
		ActiveSessionID: "$1",
	}

	state.ApplySessionRenamed("dev2")

	s := state.FindSession("$1")
	if s.Name != "dev2" {
		t.Errorf("Name = %q, want dev2", s.Name)
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run "TestTmuxState_Apply"`

Expected: compilation error — `Apply*` methods not defined.

**Step 3: Write the implementation**

Add to `internal/tmux/model.go` (after the existing Find methods):

```go
// ApplySessionChanged handles a %session-changed event.
// Creates the session if it doesn't exist, sets it as active.
func (s *TmuxState) ApplySessionChanged(sessionID, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.ActiveSessionID = sessionID
	for i := range s.Sessions {
		if s.Sessions[i].ID == sessionID {
			s.Sessions[i].Name = name
			return
		}
	}
	s.Sessions = append(s.Sessions, Session{ID: sessionID, Name: name})
}

// ApplyWindowAdd handles a %window-add event.
// Adds the window to the active session.
func (s *TmuxState) ApplyWindowAdd(windowID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	sess := s.activeSessionLocked()
	if sess == nil {
		return
	}
	// Don't add duplicates
	for _, w := range sess.Windows {
		if w.ID == windowID {
			return
		}
	}
	sess.Windows = append(sess.Windows, Window{ID: windowID})
}

// ApplyWindowClose handles a %window-close event.
// Removes the window from all sessions.
func (s *TmuxState) ApplyWindowClose(windowID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.Sessions {
		windows := s.Sessions[i].Windows[:0]
		for _, w := range s.Sessions[i].Windows {
			if w.ID != windowID {
				windows = append(windows, w)
			}
		}
		s.Sessions[i].Windows = windows
	}
}

// ApplyWindowRenamed handles a %window-renamed event.
func (s *TmuxState) ApplyWindowRenamed(windowID, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.Sessions {
		for j := range s.Sessions[i].Windows {
			if s.Sessions[i].Windows[j].ID == windowID {
				s.Sessions[i].Windows[j].Name = name
				return
			}
		}
	}
}

// ApplyLayoutChange handles a %layout-change event.
// Updates the window's layout string and rebuilds its pane list from the layout.
func (s *TmuxState) ApplyLayoutChange(windowID, layout string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.Sessions {
		for j := range s.Sessions[i].Windows {
			if s.Sessions[i].Windows[j].ID == windowID {
				w := &s.Sessions[i].Windows[j]
				w.Layout = layout
				s.rebuildPanesFromLayout(w)
				return
			}
		}
	}
}

// ApplySessionWindowChanged handles a %session-window-changed event.
// Sets the active window for the session.
func (s *TmuxState) ApplySessionWindowChanged(sessionID, windowID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.Sessions {
		if s.Sessions[i].ID == sessionID {
			for j := range s.Sessions[i].Windows {
				s.Sessions[i].Windows[j].Active = (s.Sessions[i].Windows[j].ID == windowID)
			}
			return
		}
	}
}

// ApplyWindowPaneChanged handles a %window-pane-changed event.
// Sets the active pane within a window.
func (s *TmuxState) ApplyWindowPaneChanged(windowID, paneID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.Sessions {
		for j := range s.Sessions[i].Windows {
			if s.Sessions[i].Windows[j].ID == windowID {
				for k := range s.Sessions[i].Windows[j].Panes {
					s.Sessions[i].Windows[j].Panes[k].Active = (s.Sessions[i].Windows[j].Panes[k].ID == paneID)
				}
				return
			}
		}
	}
}

// ApplySessionRenamed handles a %session-renamed event.
// Renames the active session.
func (s *TmuxState) ApplySessionRenamed(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.Sessions {
		if s.Sessions[i].ID == s.ActiveSessionID {
			s.Sessions[i].Name = name
			return
		}
	}
}

// activeSessionLocked returns the active session. Caller must hold s.mu.
func (s *TmuxState) activeSessionLocked() *Session {
	for i := range s.Sessions {
		if s.Sessions[i].ID == s.ActiveSessionID {
			return &s.Sessions[i]
		}
	}
	return nil
}

// rebuildPanesFromLayout parses the layout string and updates the window's pane list.
// Preserves existing pane data (like Active state) where possible.
func (s *TmuxState) rebuildPanesFromLayout(w *Window) {
	node, err := ParseLayout(w.Layout)
	if err != nil {
		return // keep existing panes if layout parse fails
	}

	// Build a map of existing panes for preservation
	existing := make(map[string]Pane)
	for _, p := range w.Panes {
		existing[p.ID] = p
	}

	ids := node.PaneIDs()
	panes := make([]Pane, 0, len(ids))
	for _, id := range ids {
		paneIDStr := fmt.Sprintf("%%%d", id)
		if p, ok := existing[paneIDStr]; ok {
			// Update dimensions from layout, keep other fields
			if ln := findLayoutNode(node, id); ln != nil {
				p.Width = ln.Width
				p.Height = ln.Height
			}
			panes = append(panes, p)
		} else {
			p := Pane{ID: paneIDStr}
			if ln := findLayoutNode(node, id); ln != nil {
				p.Width = ln.Width
				p.Height = ln.Height
			}
			panes = append(panes, p)
		}
	}
	w.Panes = panes
}

// findLayoutNode finds the leaf node with the given pane ID in a layout tree.
func findLayoutNode(n *LayoutNode, paneID int) *LayoutNode {
	if n.Type == PaneNode {
		if n.PaneID == paneID {
			return n
		}
		return nil
	}
	for _, child := range n.Children {
		if found := findLayoutNode(child, paneID); found != nil {
			return found
		}
	}
	return nil
}
```

Note: `rebuildPanesFromLayout` uses `fmt.Sprintf` — add `"fmt"` to the imports in `model.go`:

```go
import (
	"fmt"
	"sync"
)
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run "TestTmuxState_Apply"`

Expected: all 8 Apply* tests PASS.

**Step 5: Run all tests**

Run: `cd ~/workspace/muxterm && go test ./... -v`

Expected: all tests PASS.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add state mutation methods for all control mode events"
```

---

### Task 6: Command Interface

**Files:**
- Create: `internal/tmux/command.go`
- Create: `internal/tmux/command_test.go`

**Context:** Commands are sent through control mode by writing to tmux's stdin. Each command is a single line terminated by newline. The command interface formats tmux commands from typed Go function calls.

**Step 1: Write the tests**

Create `internal/tmux/command_test.go`:

```go
package tmux

import (
	"bytes"
	"testing"
)

func TestCommandSendKeys(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.SendKeys("%5", "hello"); err != nil {
		t.Fatal(err)
	}
	got := buf.String()
	want := "send-keys -t %5 -- hello\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandSendKeysLiteral(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.SendKeysLiteral("%5", []byte("\x1b[A")); err != nil {
		t.Fatal(err)
	}
	got := buf.String()
	// For raw bytes, we use send-keys -l (literal) with hex key notation
	// Actually for raw terminal data we use send-keys with the hex escape
	want := "send-keys -t %5 -H 1b 5b 41\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCommandSelectWindow(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.SelectWindow("@3"); err != nil {
		t.Fatal(err)
	}
	want := "select-window -t @3\n"
	if buf.String() != want {
		t.Errorf("got %q, want %q", buf.String(), want)
	}
}

func TestCommandSelectPane(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.SelectPane("%5"); err != nil {
		t.Fatal(err)
	}
	want := "select-pane -t %5\n"
	if buf.String() != want {
		t.Errorf("got %q, want %q", buf.String(), want)
	}
}

func TestCommandSplitWindow(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.SplitWindow("%5", true); err != nil {
		t.Fatal(err)
	}
	want := "split-window -h -t %5\n"
	if buf.String() != want {
		t.Errorf("got %q, want %q", buf.String(), want)
	}
}

func TestCommandSplitWindowVertical(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.SplitWindow("%5", false); err != nil {
		t.Fatal(err)
	}
	want := "split-window -v -t %5\n"
	if buf.String() != want {
		t.Errorf("got %q, want %q", buf.String(), want)
	}
}

func TestCommandResizePane(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.ResizePane("%5", 100, 40); err != nil {
		t.Fatal(err)
	}
	want := "resize-pane -t %5 -x 100 -y 40\n"
	if buf.String() != want {
		t.Errorf("got %q, want %q", buf.String(), want)
	}
}

func TestCommandNewWindow(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.NewWindow(""); err != nil {
		t.Fatal(err)
	}
	want := "new-window\n"
	if buf.String() != want {
		t.Errorf("got %q, want %q", buf.String(), want)
	}
}

func TestCommandNewWindowWithName(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.NewWindow("build"); err != nil {
		t.Fatal(err)
	}
	want := "new-window -n build\n"
	if buf.String() != want {
		t.Errorf("got %q, want %q", buf.String(), want)
	}
}

func TestCommandClosePane(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.ClosePane("%5"); err != nil {
		t.Fatal(err)
	}
	want := "kill-pane -t %5\n"
	if buf.String() != want {
		t.Errorf("got %q, want %q", buf.String(), want)
	}
}

func TestCommandRenameWindow(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.RenameWindow("@3", "vim"); err != nil {
		t.Fatal(err)
	}
	want := "rename-window -t @3 vim\n"
	if buf.String() != want {
		t.Errorf("got %q, want %q", buf.String(), want)
	}
}

func TestCommandCreateSession(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.CreateSession("test"); err != nil {
		t.Fatal(err)
	}
	want := "new-session -d -s test\n"
	if buf.String() != want {
		t.Errorf("got %q, want %q", buf.String(), want)
	}
}

func TestCommandListWindows(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.ListWindows(); err != nil {
		t.Fatal(err)
	}
	want := "list-windows -F '#{window_id} #{window_name} #{window_layout} #{window_active}'\n"
	if buf.String() != want {
		t.Errorf("got %q, want %q", buf.String(), want)
	}
}

func TestCommandListPanes(t *testing.T) {
	var buf bytes.Buffer
	cw := &CommandWriter{W: &buf}

	if err := cw.ListPanes(); err != nil {
		t.Fatal(err)
	}
	want := "list-panes -s -F '#{pane_id} #{pane_width} #{pane_height} #{pane_active}'\n"
	if buf.String() != want {
		t.Errorf("got %q, want %q", buf.String(), want)
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run TestCommand`

Expected: compilation error — `CommandWriter` not defined.

**Step 3: Write the implementation**

Create `internal/tmux/command.go`:

```go
package tmux

import (
	"fmt"
	"io"
	"sync"
)

// CommandWriter sends tmux commands through a control mode connection.
// It is safe for concurrent use.
type CommandWriter struct {
	W  io.Writer
	mu sync.Mutex
}

// send writes a formatted command line to the tmux control mode stdin.
func (c *CommandWriter) send(format string, args ...any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	line := fmt.Sprintf(format, args...)
	_, err := fmt.Fprintf(c.W, "%s\n", line)
	return err
}

// SendKeys sends text to a pane via send-keys.
// Use for text that tmux should interpret (e.g., key names like "Enter").
func (c *CommandWriter) SendKeys(paneID, keys string) error {
	return c.send("send-keys -t %s -- %s", paneID, keys)
}

// SendKeysLiteral sends raw bytes to a pane using hex notation.
// Use for raw terminal data from the browser (keyboard input).
func (c *CommandWriter) SendKeysLiteral(paneID string, data []byte) error {
	hex := ""
	for i, b := range data {
		if i > 0 {
			hex += " "
		}
		hex += fmt.Sprintf("%02x", b)
	}
	return c.send("send-keys -t %s -H %s", paneID, hex)
}

// SelectWindow switches the active window.
func (c *CommandWriter) SelectWindow(windowID string) error {
	return c.send("select-window -t %s", windowID)
}

// SelectPane switches the active pane.
func (c *CommandWriter) SelectPane(paneID string) error {
	return c.send("select-pane -t %s", paneID)
}

// SplitWindow creates a new pane by splitting. horizontal=true for side-by-side, false for stacked.
func (c *CommandWriter) SplitWindow(paneID string, horizontal bool) error {
	dir := "-v"
	if horizontal {
		dir = "-h"
	}
	return c.send("split-window %s -t %s", dir, paneID)
}

// ResizePane resizes a pane to the given dimensions.
func (c *CommandWriter) ResizePane(paneID string, width, height int) error {
	return c.send("resize-pane -t %s -x %d -y %d", paneID, width, height)
}

// NewWindow creates a new window. If name is empty, tmux chooses the name.
func (c *CommandWriter) NewWindow(name string) error {
	if name == "" {
		return c.send("new-window")
	}
	return c.send("new-window -n %s", name)
}

// ClosePane kills a pane.
func (c *CommandWriter) ClosePane(paneID string) error {
	return c.send("kill-pane -t %s", paneID)
}

// RenameWindow renames a window.
func (c *CommandWriter) RenameWindow(windowID, name string) error {
	return c.send("rename-window -t %s %s", windowID, name)
}

// CreateSession creates a new detached session.
func (c *CommandWriter) CreateSession(name string) error {
	return c.send("new-session -d -s %s", name)
}

// ListWindows requests the window list for state sync.
func (c *CommandWriter) ListWindows() error {
	return c.send("list-windows -F '#{window_id} #{window_name} #{window_layout} #{window_active}'")
}

// ListPanes requests the pane list for state sync.
func (c *CommandWriter) ListPanes() error {
	return c.send("list-panes -s -F '#{pane_id} #{pane_width} #{pane_height} #{pane_active}'")
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run TestCommand`

Expected: all 14 tests PASS.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add CommandWriter for sending tmux commands through control mode"
```

---

### Task 7: Controller (tmux Process Management)

**Files:**
- Modify: `internal/tmux/control.go` (add Controller, EventReader)
- Modify: `internal/tmux/control_test.go` (add EventReader and Controller tests)

**Context:** The Controller manages the `tmux -CC attach` process. It reads events from tmux's stdout, parses them, updates the TmuxState, and forwards events to consumers via a channel. Commands are sent via the CommandWriter writing to tmux's stdin. The EventReader handles %begin/%end blocks (command response tracking).

**Step 1: Write the tests**

Add to `internal/tmux/control_test.go`:

```go
import (
	"bufio"
	"bytes"
	"io"
	"strings"
	"testing"
	"time"
)

func TestEventReader_Notifications(t *testing.T) {
	input := strings.Join([]string{
		"%session-changed $1 dev",
		"%window-add @2",
		"%output %3 hello",
		"%layout-change @2 abcd,80x24,0,0,3 abcd,80x24,0,0,3 *",
	}, "\n") + "\n"

	r := NewEventReader(bufio.NewReader(strings.NewReader(input)))

	// Event 1: session-changed
	ev, err := r.ReadEvent()
	if err != nil {
		t.Fatalf("event 1: %v", err)
	}
	if _, ok := ev.(*SessionChangedEvent); !ok {
		t.Errorf("event 1 type = %T, want *SessionChangedEvent", ev)
	}

	// Event 2: window-add
	ev, err = r.ReadEvent()
	if err != nil {
		t.Fatalf("event 2: %v", err)
	}
	if _, ok := ev.(*WindowAddEvent); !ok {
		t.Errorf("event 2 type = %T", ev)
	}

	// Event 3: output
	ev, err = r.ReadEvent()
	if err != nil {
		t.Fatalf("event 3: %v", err)
	}
	if out, ok := ev.(*OutputEvent); !ok {
		t.Errorf("event 3 type = %T", ev)
	} else if string(out.Data) != "hello" {
		t.Errorf("event 3 data = %q", out.Data)
	}

	// Event 4: layout-change
	ev, err = r.ReadEvent()
	if err != nil {
		t.Fatalf("event 4: %v", err)
	}
	if _, ok := ev.(*LayoutChangeEvent); !ok {
		t.Errorf("event 4 type = %T", ev)
	}

	// Should get EOF
	_, err = r.ReadEvent()
	if err != io.EOF {
		t.Errorf("expected io.EOF, got %v", err)
	}
}

func TestEventReader_CommandBlock(t *testing.T) {
	input := strings.Join([]string{
		"%begin 1234567890 1 0",
		"0: bash* (1 panes) [80x24]",
		"1: vim- (1 panes) [80x24]",
		"%end 1234567890 1 0",
		"%window-add @5",
	}, "\n") + "\n"

	r := NewEventReader(bufio.NewReader(strings.NewReader(input)))

	// First event should be the command result
	ev, err := r.ReadEvent()
	if err != nil {
		t.Fatalf("event 1: %v", err)
	}
	cr, ok := ev.(*CommandResultEvent)
	if !ok {
		t.Fatalf("event 1 type = %T, want *CommandResultEvent", ev)
	}
	if !cr.Success {
		t.Error("expected Success=true")
	}
	if len(cr.Lines) != 2 {
		t.Fatalf("len(Lines) = %d, want 2", len(cr.Lines))
	}
	if cr.Lines[0] != "0: bash* (1 panes) [80x24]" {
		t.Errorf("Lines[0] = %q", cr.Lines[0])
	}

	// Second event should be the window-add notification
	ev, err = r.ReadEvent()
	if err != nil {
		t.Fatalf("event 2: %v", err)
	}
	if _, ok := ev.(*WindowAddEvent); !ok {
		t.Errorf("event 2 type = %T", ev)
	}
}

func TestEventReader_CommandError(t *testing.T) {
	input := strings.Join([]string{
		"%begin 1234567890 1 0",
		"session not found: test",
		"%error 1234567890 1 0",
	}, "\n") + "\n"

	r := NewEventReader(bufio.NewReader(strings.NewReader(input)))

	ev, err := r.ReadEvent()
	if err != nil {
		t.Fatalf("ReadEvent: %v", err)
	}
	cr, ok := ev.(*CommandResultEvent)
	if !ok {
		t.Fatalf("type = %T, want *CommandResultEvent", ev)
	}
	if cr.Success {
		t.Error("expected Success=false")
	}
	if len(cr.Lines) != 1 {
		t.Fatalf("len(Lines) = %d, want 1", len(cr.Lines))
	}
}

func TestController_EventDispatch(t *testing.T) {
	// Simulate a tmux control mode stream using pipes
	pr, pw := io.Pipe()
	eventsCh := make(chan Event, 10)

	ctrl := NewController(&ControllerConfig{
		Reader: pr,
		Writer: io.Discard,
		Events: eventsCh,
	})

	go ctrl.Run()

	// Write simulated control mode output
	go func() {
		pw.Write([]byte("%session-changed $1 dev\n"))
		pw.Write([]byte("%window-add @2\n"))
		pw.Write([]byte("%layout-change @2 abcd,80x24,0,0,3 abcd,80x24,0,0,3 *\n"))
		pw.Write([]byte("%output %3 hello\n"))
		pw.Close()
	}()

	// Collect events with timeout
	var events []Event
	timeout := time.After(2 * time.Second)
	for {
		select {
		case ev, ok := <-eventsCh:
			if !ok {
				goto done
			}
			events = append(events, ev)
		case <-timeout:
			t.Fatal("timeout waiting for events")
		}
	}
done:

	if len(events) != 4 {
		t.Fatalf("received %d events, want 4", len(events))
	}

	// Check that state was updated
	state := ctrl.State()
	if state.ActiveSessionID != "$1" {
		t.Errorf("ActiveSessionID = %q, want $1", state.ActiveSessionID)
	}
	sess := state.FindSession("$1")
	if sess == nil {
		t.Fatal("session $1 not found")
	}
	if len(sess.Windows) != 1 || sess.Windows[0].ID != "@2" {
		t.Errorf("windows = %+v", sess.Windows)
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run "TestEventReader|TestController_Event"`

Expected: compilation error — `EventReader`, `Controller`, etc. not defined.

**Step 3: Write the implementation**

Add to `internal/tmux/control.go` (after the existing ParseEvent code):

```go
import (
	"bufio"
	"io"
	// ... existing imports ...
)

// CommandResultEvent represents the result of a command sent through control mode.
type CommandResultEvent struct {
	CmdNumber int
	Lines     []string
	Success   bool // true if %end, false if %error
}

func (*CommandResultEvent) eventMarker() {}

// EventReader reads from a tmux control mode stream and produces Events.
// It handles %begin/%end blocks internally, collapsing them into CommandResultEvents.
type EventReader struct {
	r *bufio.Reader
}

// NewEventReader creates an EventReader from a buffered reader.
func NewEventReader(r *bufio.Reader) *EventReader {
	return &EventReader{r: r}
}

// ReadEvent returns the next event from the control mode stream.
// Returns io.EOF when the stream ends.
func (er *EventReader) ReadEvent() (Event, error) {
	for {
		line, err := er.r.ReadString('\n')
		if err != nil {
			if err == io.EOF && line == "" {
				return nil, io.EOF
			}
			if line == "" {
				return nil, err
			}
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			continue
		}

		if strings.HasPrefix(line, "%begin ") {
			return er.readBlock(line)
		}

		if strings.HasPrefix(line, "%") {
			return ParseEvent(line)
		}

		// Non-% lines outside blocks are unexpected; skip them.
	}
}

// readBlock reads a %begin/%end command response block.
func (er *EventReader) readBlock(beginLine string) (Event, error) {
	var lines []string
	for {
		line, err := er.r.ReadString('\n')
		if err != nil {
			if err == io.EOF && line == "" {
				return nil, fmt.Errorf("unexpected EOF in command block")
			}
			if line == "" {
				return nil, err
			}
		}
		line = strings.TrimRight(line, "\r\n")

		if strings.HasPrefix(line, "%end ") {
			return &CommandResultEvent{Lines: lines, Success: true}, nil
		}
		if strings.HasPrefix(line, "%error ") {
			return &CommandResultEvent{Lines: lines, Success: false}, nil
		}
		lines = append(lines, line)
	}
}

// ControllerConfig configures a Controller.
type ControllerConfig struct {
	Reader io.Reader  // tmux stdout (events come from here)
	Writer io.Writer  // tmux stdin (commands go here)
	Events chan Event  // channel where parsed events are sent
}

// Controller manages a tmux control mode connection.
// It reads events, updates the TmuxState, and forwards events to consumers.
type Controller struct {
	state    TmuxState
	cmds     *CommandWriter
	events   chan Event
	reader   io.Reader
}

// NewController creates a Controller from a config.
func NewController(cfg *ControllerConfig) *Controller {
	return &Controller{
		reader:   cfg.Reader,
		cmds:     &CommandWriter{W: cfg.Writer},
		events:   cfg.Events,
	}
}

// State returns a snapshot of the current tmux state.
func (c *Controller) State() *TmuxState {
	return &c.state
}

// Commands returns the CommandWriter for sending commands to tmux.
func (c *Controller) Commands() *CommandWriter {
	return c.cmds
}

// Run reads events from the control mode stream and processes them.
// It blocks until the stream ends or an error occurs.
// Events are forwarded to the Events channel after state is updated.
// The Events channel is closed when Run returns.
func (c *Controller) Run() error {
	defer close(c.events)

	er := NewEventReader(bufio.NewReader(c.reader))
	for {
		ev, err := er.ReadEvent()
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("read event: %w", err)
		}

		c.applyEvent(ev)

		// Forward to consumer (non-blocking if channel is full, we drop)
		select {
		case c.events <- ev:
		default:
			// Consumer too slow — drop event.
			// In production this should log or use a larger buffer.
		}
	}
}

// applyEvent updates the TmuxState based on the event.
func (c *Controller) applyEvent(ev Event) {
	switch e := ev.(type) {
	case *SessionChangedEvent:
		c.state.ApplySessionChanged(e.SessionID, e.Name)
	case *WindowAddEvent:
		c.state.ApplyWindowAdd(e.WindowID)
	case *WindowCloseEvent:
		c.state.ApplyWindowClose(e.WindowID)
	case *WindowRenamedEvent:
		c.state.ApplyWindowRenamed(e.WindowID, e.Name)
	case *LayoutChangeEvent:
		c.state.ApplyLayoutChange(e.WindowID, e.Layout)
	case *SessionWindowChangedEvent:
		c.state.ApplySessionWindowChanged(e.SessionID, e.WindowID)
	case *WindowPaneChangedEvent:
		c.state.ApplyWindowPaneChanged(e.WindowID, e.PaneID)
	case *SessionRenamedEvent:
		c.state.ApplySessionRenamed(e.Name)
	// OutputEvent, PaneModeChangedEvent, CommandResultEvent, etc.
	// don't mutate TmuxState — they're forwarded as-is.
	}
}
```

Make sure the imports at the top of `control.go` include all needed packages:

```go
import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run "TestEventReader|TestController_Event"`

Expected: all 4 tests PASS.

**Step 5: Run all tests**

Run: `cd ~/workspace/muxterm && go test ./... -v`

Expected: all tests PASS. No regressions.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: add Controller and EventReader for tmux process management"
```

---

### Task 8: CLI Debug Mode and Manual Verification

**Files:**
- Modify: `cmd/muxterm/main.go` (wire up Controller for real tmux connection)

**Context:** Connect the CLI to a real tmux session so we can manually verify the entire pipeline works: process start -> event parsing -> state updates -> command sending. This is NOT just for integration tests — this is the primary way to confirm the control mode engine actually works before building the WebSocket layer.

**Step 1: Update main.go to connect to tmux**

Replace `cmd/muxterm/main.go` with:

```go
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"

	"github.com/user/muxterm/internal/tmux"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "muxterm: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	// Determine which session to connect to
	session := "muxterm"
	if len(os.Args) > 1 {
		session = os.Args[1]
	}

	// Ensure session exists
	if err := ensureSession(session); err != nil {
		return fmt.Errorf("ensure session: %w", err)
	}

	fmt.Fprintf(os.Stderr, "[muxterm] connecting to tmux session %q in control mode...\n", session)

	// Start tmux in control mode
	cmd := exec.Command("tmux", "-CC", "attach-session", "-t", session)
	cmd.Stderr = os.Stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start tmux: %w", err)
	}

	fmt.Fprintf(os.Stderr, "[muxterm] connected. pid=%d\n", cmd.Process.Pid)

	// Set up controller
	events := make(chan tmux.Event, 100)
	ctrl := tmux.NewController(&tmux.ControllerConfig{
		Reader: stdout,
		Writer: stdin,
		Events: events,
	})

	// Handle Ctrl+C
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Run controller in background
	done := make(chan error, 1)
	go func() {
		done <- ctrl.Run()
	}()

	// Process events and print them
	fmt.Fprintf(os.Stderr, "[muxterm] listening for events (Ctrl+C to quit)...\n\n")
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				fmt.Fprintf(os.Stderr, "\n[muxterm] event channel closed\n")
				goto cleanup
			}
			printEvent(ev)
		case <-ctx.Done():
			fmt.Fprintf(os.Stderr, "\n[muxterm] shutting down...\n")
			stdin.Close()
			goto cleanup
		}
	}

cleanup:
	// Wait for controller to finish
	if err := <-done; err != nil {
		fmt.Fprintf(os.Stderr, "[muxterm] controller error: %v\n", err)
	}

	// Print final state
	state := ctrl.State()
	stateJSON, _ := json.MarshalIndent(state, "", "  ")
	fmt.Fprintf(os.Stderr, "\n[muxterm] final state:\n%s\n", stateJSON)

	// Kill tmux process if still running
	cmd.Process.Signal(syscall.SIGTERM)
	cmd.Wait()

	return nil
}

func ensureSession(name string) error {
	// Check if session already exists
	check := exec.Command("tmux", "has-session", "-t", name)
	if err := check.Run(); err == nil {
		return nil // session exists
	}
	// Create new session
	create := exec.Command("tmux", "new-session", "-d", "-s", name, "-x", "200", "-y", "50")
	if err := create.Run(); err != nil {
		return fmt.Errorf("create session %q: %w", name, err)
	}
	fmt.Fprintf(os.Stderr, "[muxterm] created new tmux session %q\n", name)
	return nil
}

func printEvent(ev tmux.Event) {
	switch e := ev.(type) {
	case *tmux.OutputEvent:
		// Show first 80 chars of output to avoid flooding
		data := string(e.Data)
		if len(data) > 80 {
			data = data[:80] + "..."
		}
		data = strings.ReplaceAll(data, "\n", "\\n")
		data = strings.ReplaceAll(data, "\r", "\\r")
		fmt.Printf("  OUTPUT      pane=%s data=%q\n", e.PaneID, data)
	case *tmux.LayoutChangeEvent:
		fmt.Printf("  LAYOUT      window=%s layout=%s\n", e.WindowID, e.Layout)
	case *tmux.WindowAddEvent:
		fmt.Printf("  WIN-ADD     window=%s\n", e.WindowID)
	case *tmux.WindowCloseEvent:
		fmt.Printf("  WIN-CLOSE   window=%s\n", e.WindowID)
	case *tmux.WindowRenamedEvent:
		fmt.Printf("  WIN-RENAME  window=%s name=%q\n", e.WindowID, e.Name)
	case *tmux.SessionChangedEvent:
		fmt.Printf("  SESS-CHG    session=%s name=%q\n", e.SessionID, e.Name)
	case *tmux.SessionWindowChangedEvent:
		fmt.Printf("  SESS-WIN    session=%s window=%s\n", e.SessionID, e.WindowID)
	case *tmux.SessionRenamedEvent:
		fmt.Printf("  SESS-RENAME name=%q\n", e.Name)
	case *tmux.SessionsChangedEvent:
		fmt.Printf("  SESSIONS-CHANGED\n")
	case *tmux.PaneModeChangedEvent:
		fmt.Printf("  PANE-MODE   pane=%s\n", e.PaneID)
	case *tmux.WindowPaneChangedEvent:
		fmt.Printf("  WIN-PANE    window=%s pane=%s\n", e.WindowID, e.PaneID)
	case *tmux.ExitEvent:
		fmt.Printf("  EXIT        reason=%q\n", e.Reason)
	case *tmux.CommandResultEvent:
		status := "OK"
		if !e.Success {
			status = "ERROR"
		}
		fmt.Printf("  CMD-RESULT  status=%s lines=%d\n", status, len(e.Lines))
		for _, line := range e.Lines {
			fmt.Printf("              | %s\n", line)
		}
	default:
		fmt.Printf("  UNKNOWN     %T\n", ev)
	}
}
```

Note: This file imports `"context"`, `"bufio"`, and `"encoding/json"` — but `"bufio"` is unused. Remove it. Only keep the imports that are actually used: `"context"`, `"encoding/json"`, `"fmt"`, `"os"`, `"os/exec"`, `"os/signal"`, `"strings"`, `"syscall"`, and the internal package.

**Step 2: Verify it builds**

Run: `cd ~/workspace/muxterm && go build -o bin/muxterm ./cmd/muxterm && echo "build OK"`

Expected: `build OK`, no errors.

**Step 3: Manual verification — connect and observe events**

Run: `cd ~/workspace/muxterm && ./bin/muxterm`

Expected output (approximate):
```
[muxterm] created new tmux session "muxterm"
[muxterm] connecting to tmux session "muxterm" in control mode...
[muxterm] connected. pid=XXXXX
[muxterm] listening for events (Ctrl+C to quit)...

  SESS-CHG    session=$N name="muxterm"
  LAYOUT      window=@N layout=XXXX,200x50,0,0,N
  CMD-RESULT  status=OK lines=...
  OUTPUT      pane=%N data=...
```

Verify you see events streaming. Then press Ctrl+C and verify the final state JSON is printed with the correct session, window, and pane structure.

**Step 4: Manual verification — trigger events**

In a separate terminal, interact with the tmux session:
```bash
tmux rename-window -t muxterm vim
tmux split-window -h -t muxterm
```

Verify the muxterm debug output shows corresponding `WIN-RENAME` and `LAYOUT` events.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add CLI debug mode connecting to real tmux control mode"
```

---

### Task 9: Integration Test with Real tmux

**Files:**
- Create: `internal/tmux/integration_test.go`

**Context:** This test connects to a real tmux server and verifies the full pipeline: start session, open control mode, receive events, send commands, verify state updates. It requires tmux to be installed and running. The test creates and destroys its own tmux session.

**Step 1: Write the integration test**

Create `internal/tmux/integration_test.go`:

```go
//go:build integration

package tmux

import (
	"io"
	"os/exec"
	"testing"
	"time"
)

// TestIntegration_ControlMode connects to a real tmux session and verifies the event pipeline.
//
// Run with: go test -tags=integration -v -run TestIntegration ./internal/tmux/
//
// Requires tmux to be installed.
func TestIntegration_ControlMode(t *testing.T) {
	// Skip if tmux is not available
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not found, skipping integration test")
	}

	session := "muxterm-integration-test"

	// Clean up any existing session
	exec.Command("tmux", "kill-session", "-t", session).Run()

	// Create a fresh session
	create := exec.Command("tmux", "new-session", "-d", "-s", session, "-x", "80", "-y", "24")
	if err := create.Run(); err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(func() {
		exec.Command("tmux", "kill-session", "-t", session).Run()
	})

	// Start tmux control mode
	cmd := exec.Command("tmux", "-CC", "attach-session", "-t", session)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin pipe: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		t.Fatalf("start tmux -CC: %v", err)
	}
	t.Cleanup(func() {
		stdin.Close()
		cmd.Process.Kill()
		cmd.Wait()
	})

	// Set up controller
	events := make(chan Event, 100)
	ctrl := NewController(&ControllerConfig{
		Reader: stdout,
		Writer: stdin,
		Events: events,
	})

	done := make(chan error, 1)
	go func() {
		done <- ctrl.Run()
	}()

	// Helper: drain events until timeout or predicate matches
	waitForEvent := func(timeout time.Duration, match func(Event) bool) Event {
		deadline := time.After(timeout)
		for {
			select {
			case ev := <-events:
				if match(ev) {
					return ev
				}
			case <-deadline:
				return nil
			}
		}
	}

	// 1. Should receive session-changed on connect
	ev := waitForEvent(5*time.Second, func(e Event) bool {
		_, ok := e.(*SessionChangedEvent)
		return ok
	})
	if ev == nil {
		t.Fatal("timeout waiting for session-changed event")
	}
	sc := ev.(*SessionChangedEvent)
	if sc.Name != session {
		t.Errorf("session name = %q, want %q", sc.Name, session)
	}
	t.Logf("received session-changed: %+v", sc)

	// Wait for initial layout event
	ev = waitForEvent(5*time.Second, func(e Event) bool {
		_, ok := e.(*LayoutChangeEvent)
		return ok
	})
	if ev == nil {
		t.Fatal("timeout waiting for initial layout-change event")
	}
	t.Logf("received layout-change: window=%s", ev.(*LayoutChangeEvent).WindowID)

	// 2. Send a command: rename the window
	cmds := ctrl.Commands()
	if err := cmds.RenameWindow(ev.(*LayoutChangeEvent).WindowID, "test-window"); err != nil {
		t.Fatalf("rename window: %v", err)
	}

	// Should receive window-renamed event
	ev = waitForEvent(5*time.Second, func(e Event) bool {
		wr, ok := e.(*WindowRenamedEvent)
		return ok && wr.Name == "test-window"
	})
	if ev == nil {
		t.Fatal("timeout waiting for window-renamed event")
	}
	t.Logf("received window-renamed: %+v", ev)

	// 3. Send keys and verify output arrives
	state := ctrl.State()
	sess := state.FindSession(sc.SessionID)
	if sess == nil || len(sess.Windows) == 0 || len(sess.Windows[0].Panes) == 0 {
		t.Fatalf("no panes in state: sessions=%+v", state.Sessions)
	}
	paneID := sess.Windows[0].Panes[0].ID
	t.Logf("sending keys to pane %s", paneID)

	if err := cmds.SendKeys(paneID, "echo muxterm-test-marker"); err != nil {
		t.Fatalf("send keys: %v", err)
	}
	if err := cmds.SendKeys(paneID, "Enter"); err != nil {
		t.Fatalf("send enter: %v", err)
	}

	// Should receive output containing our marker
	ev = waitForEvent(5*time.Second, func(e Event) bool {
		out, ok := e.(*OutputEvent)
		return ok && containsBytes(out.Data, []byte("muxterm-test-marker"))
	})
	if ev == nil {
		t.Fatal("timeout waiting for output with test marker")
	}
	t.Logf("received output with marker from pane %s", ev.(*OutputEvent).PaneID)

	// 4. Split the window and verify layout change
	if err := cmds.SplitWindow(paneID, true); err != nil {
		t.Fatalf("split window: %v", err)
	}

	ev = waitForEvent(5*time.Second, func(e Event) bool {
		_, ok := e.(*LayoutChangeEvent)
		return ok
	})
	if ev == nil {
		t.Fatal("timeout waiting for layout-change after split")
	}
	lc := ev.(*LayoutChangeEvent)
	t.Logf("received layout-change after split: %s", lc.Layout)

	// Verify state has 2 panes now
	state = ctrl.State()
	for _, s := range state.Sessions {
		for _, w := range s.Windows {
			if len(w.Panes) >= 2 {
				t.Logf("state has %d panes after split", len(w.Panes))
				goto splitVerified
			}
		}
	}
	t.Error("state should have at least 2 panes after split")
splitVerified:

	// 5. Clean shutdown
	stdin.Close()
	select {
	case err := <-done:
		if err != nil && err != io.EOF {
			t.Errorf("controller error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Error("timeout waiting for controller to finish")
	}

	t.Log("integration test passed")
}

func containsBytes(haystack, needle []byte) bool {
	for i := 0; i <= len(haystack)-len(needle); i++ {
		match := true
		for j := 0; j < len(needle); j++ {
			if haystack[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
```

**Step 2: Run the integration test**

Run: `cd ~/workspace/muxterm && go test -tags=integration -v -timeout 30s -run TestIntegration ./internal/tmux/`

Expected output (approximate):
```
=== RUN   TestIntegration_ControlMode
    received session-changed: ...
    received layout-change: window=@N
    received window-renamed: ...
    sending keys to pane %N
    received output with marker from pane %N
    received layout-change after split: ...
    state has 2 panes after split
    integration test passed
--- PASS: TestIntegration_ControlMode
```

If it fails, debug by running `./bin/muxterm` manually to see what events are actually being produced.

**Step 3: Verify unit tests still pass**

Run: `cd ~/workspace/muxterm && go test ./... -v`

Expected: all unit tests PASS (integration test is skipped without the build tag).

**Step 4: Commit**

```bash
git add -A && git commit -m "test: add integration test verifying full tmux control mode pipeline"
```

---

## Post-Phase Verification Checklist

After all tasks are complete, run these commands to verify the full phase:

```bash
cd ~/workspace/muxterm

# 1. All unit tests pass
go test ./... -v

# 2. Integration test passes
go test -tags=integration -v -timeout 30s -run TestIntegration ./internal/tmux/

# 3. Binary builds and runs
make build
./bin/muxterm

# 4. Code is clean
go vet ./...

# 5. File structure matches design
find . -name '*.go' | sort
# Expected:
#   ./cmd/muxterm/main.go
#   ./internal/tmux/command.go
#   ./internal/tmux/command_test.go
#   ./internal/tmux/control.go
#   ./internal/tmux/control_test.go
#   ./internal/tmux/integration_test.go
#   ./internal/tmux/layout.go
#   ./internal/tmux/layout_test.go
#   ./internal/tmux/model.go
#   ./internal/tmux/model_test.go
```
