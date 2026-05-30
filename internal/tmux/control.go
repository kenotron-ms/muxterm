package tmux

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
)

// Event is the interface implemented by all tmux control mode notification types.
type Event interface {
	eventMarker()
}

// OutputEvent represents a %output notification with pane data.
type OutputEvent struct {
	PaneID string
	Data   []byte
}

func (OutputEvent) eventMarker() {}

// LayoutChangeEvent represents a %layout-change notification.
type LayoutChangeEvent struct {
	WindowID      string
	Layout        string
	VisibleLayout string
	Flags         string
}

func (LayoutChangeEvent) eventMarker() {}

// WindowAddEvent represents a %window-add notification.
type WindowAddEvent struct {
	WindowID string
}

func (WindowAddEvent) eventMarker() {}

// WindowCloseEvent represents a %window-close notification.
type WindowCloseEvent struct {
	WindowID string
}

func (WindowCloseEvent) eventMarker() {}

// WindowRenamedEvent represents a %window-renamed notification.
type WindowRenamedEvent struct {
	WindowID string
	Name     string
}

func (WindowRenamedEvent) eventMarker() {}

// SessionChangedEvent represents a %session-changed notification.
type SessionChangedEvent struct {
	SessionID string
	Name      string
}

func (SessionChangedEvent) eventMarker() {}

// SessionWindowChangedEvent represents a %session-window-changed notification.
type SessionWindowChangedEvent struct {
	SessionID string
	WindowID  string
}

func (SessionWindowChangedEvent) eventMarker() {}

// SessionRenamedEvent represents a %session-renamed notification.
type SessionRenamedEvent struct {
	Name string
}

func (SessionRenamedEvent) eventMarker() {}

// SessionsChangedEvent represents a %sessions-changed notification.
type SessionsChangedEvent struct{}

func (SessionsChangedEvent) eventMarker() {}

// PaneModeChangedEvent represents a %pane-mode-changed notification.
type PaneModeChangedEvent struct {
	PaneID string
}

func (PaneModeChangedEvent) eventMarker() {}

// WindowPaneChangedEvent represents a %window-pane-changed notification.
type WindowPaneChangedEvent struct {
	WindowID string
	PaneID   string
}

func (WindowPaneChangedEvent) eventMarker() {}

// ExitEvent represents a %exit notification.
type ExitEvent struct {
	Reason string
}

func (ExitEvent) eventMarker() {}

// BeginEvent represents a %begin block marker.
type BeginEvent struct {
	Time      int64
	CmdNumber int
	Flags     int
}

func (BeginEvent) eventMarker() {}

// EndEvent represents an %end block marker.
type EndEvent struct {
	Time      int64
	CmdNumber int
	Flags     int
}

func (EndEvent) eventMarker() {}

// ErrorEvent represents an %error block marker.
type ErrorEvent struct {
	Time      int64
	CmdNumber int
	Flags     int
}

func (ErrorEvent) eventMarker() {}

// UnknownEvent represents an unrecognized notification for forward compatibility.
type UnknownEvent struct {
	Name string
	Args string
}

func (UnknownEvent) eventMarker() {}

// ParseEvent parses a tmux control mode notification line into a typed Event.
func ParseEvent(line string) (Event, error) {
	if len(line) == 0 || line[0] != '%' {
		return nil, fmt.Errorf("not a control mode event: %q", line)
	}

	name, args, _ := strings.Cut(line[1:], " ")

	switch name {
	case "output":
		return parseOutputEvent(args)
	case "layout-change":
		return parseLayoutChangeEvent(args)
	case "window-add":
		return WindowAddEvent{WindowID: args}, nil
	case "window-close":
		return WindowCloseEvent{WindowID: args}, nil
	case "window-renamed":
		id, n, _ := strings.Cut(args, " ")
		return WindowRenamedEvent{WindowID: id, Name: n}, nil
	case "session-changed":
		id, n, _ := strings.Cut(args, " ")
		return SessionChangedEvent{SessionID: id, Name: n}, nil
	case "session-window-changed":
		sid, wid, _ := strings.Cut(args, " ")
		return SessionWindowChangedEvent{SessionID: sid, WindowID: wid}, nil
	case "session-renamed":
		return SessionRenamedEvent{Name: args}, nil
	case "sessions-changed":
		return SessionsChangedEvent{}, nil
	case "pane-mode-changed":
		return PaneModeChangedEvent{PaneID: args}, nil
	case "window-pane-changed":
		wid, pid, _ := strings.Cut(args, " ")
		return WindowPaneChangedEvent{WindowID: wid, PaneID: pid}, nil
	case "exit":
		return ExitEvent{Reason: args}, nil
	case "begin":
		return parseBlockMarker(args, func(t int64, cn, f int) Event { return BeginEvent{Time: t, CmdNumber: cn, Flags: f} })
	case "end":
		return parseBlockMarker(args, func(t int64, cn, f int) Event { return EndEvent{Time: t, CmdNumber: cn, Flags: f} })
	case "error":
		return parseBlockMarker(args, func(t int64, cn, f int) Event { return ErrorEvent{Time: t, CmdNumber: cn, Flags: f} })
	default:
		return UnknownEvent{Name: name, Args: args}, nil
	}
}

func parseOutputEvent(args string) (Event, error) {
	paneID, data, ok := strings.Cut(args, " ")
	if !ok {
		return nil, fmt.Errorf("invalid %%output: missing data")
	}
	return OutputEvent{PaneID: paneID, Data: unescapeOctal(data)}, nil
}

func parseLayoutChangeEvent(args string) (Event, error) {
	parts := strings.SplitN(args, " ", 4)
	if len(parts) < 4 {
		return nil, fmt.Errorf("invalid %%layout-change: expected 4 fields, got %d", len(parts))
	}
	return LayoutChangeEvent{WindowID: parts[0], Layout: parts[1], VisibleLayout: parts[2], Flags: parts[3]}, nil
}

func parseBlockMarker(args string, make_ func(int64, int, int) Event) (Event, error) {
	parts := strings.SplitN(args, " ", 3)
	if len(parts) < 3 {
		return nil, fmt.Errorf("invalid block marker: expected 3 fields, got %d", len(parts))
	}
	t, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid block marker time: %w", err)
	}
	cn, err := strconv.Atoi(parts[1])
	if err != nil {
		return nil, fmt.Errorf("invalid block marker cmd number: %w", err)
	}
	f, err := strconv.Atoi(parts[2])
	if err != nil {
		return nil, fmt.Errorf("invalid block marker flags: %w", err)
	}
	return make_(t, cn, f), nil
}

// CommandResultEvent represents the result of a %begin/%end or %begin/%error block.
type CommandResultEvent struct {
	CmdNumber int
	Lines     []string
	Success   bool
}

func (CommandResultEvent) eventMarker() {}

// EventReader reads tmux control mode events from a buffered stream,
// collapsing %begin/%end blocks into CommandResultEvents.
type EventReader struct {
	r *bufio.Reader
}

// NewEventReader creates an EventReader wrapping the given buffered reader.
func NewEventReader(r *bufio.Reader) *EventReader {
	return &EventReader{r: r}
}

// ReadEvent reads the next event from the stream.
// It skips empty lines and non-% lines outside blocks.
// %begin lines are dispatched to readBlock().
// Other % lines are dispatched to ParseEvent().
// Returns io.EOF on stream end.
func (er *EventReader) ReadEvent() (Event, error) {
	for {
		line, err := er.r.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")

		if err != nil && line == "" {
			if err == io.EOF {
				return nil, io.EOF
			}
			return nil, fmt.Errorf("read event: %w", err)
		}

		// Skip empty lines
		if line == "" {
			continue
		}

		// Skip non-% lines outside blocks
		if line[0] != '%' {
			continue
		}

		// Check if this is a %begin line
		if strings.HasPrefix(line, "%begin ") {
			return er.readBlock(line)
		}

		// Dispatch other % lines to ParseEvent
		return ParseEvent(line)
	}
}

// readBlock reads lines until %end or %error, collecting intermediate lines
// into a CommandResultEvent.
func (er *EventReader) readBlock(beginLine string) (Event, error) {
	// Parse the begin event to get CmdNumber
	beginEv, err := ParseEvent(beginLine)
	if err != nil {
		return nil, fmt.Errorf("parse begin: %w", err)
	}
	begin := beginEv.(BeginEvent)

	var lines []string
	for {
		line, err := er.r.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")

		if err != nil && line == "" {
			if err == io.EOF {
				return nil, fmt.Errorf("unexpected EOF in command block")
			}
			return nil, fmt.Errorf("read block: %w", err)
		}

		if strings.HasPrefix(line, "%end ") {
			return CommandResultEvent{
				CmdNumber: begin.CmdNumber,
				Lines:     lines,
				Success:   true,
			}, nil
		}

		if strings.HasPrefix(line, "%error ") {
			return CommandResultEvent{
				CmdNumber: begin.CmdNumber,
				Lines:     lines,
				Success:   false,
			}, nil
		}

		lines = append(lines, line)
	}
}

// ControllerConfig holds the configuration for creating a Controller.
type ControllerConfig struct {
	Reader io.Reader
	Writer io.Writer
	Events chan Event
}

// Controller manages tmux state and command dispatch.
type Controller struct {
	state    TmuxState
	cmds     *CommandWriter
	events   chan Event
	reader   io.Reader
	done     chan struct{} // closed by Stop() to unblock any in-progress send
	stopOnce sync.Once
}

// NewController creates a Controller from the given configuration.
func NewController(cfg ControllerConfig) *Controller {
	return &Controller{
		cmds:   &CommandWriter{W: cfg.Writer},
		events: cfg.Events,
		reader: cfg.Reader,
		done:   make(chan struct{}),
	}
}

// Stop signals the controller to stop forwarding events. Safe to call multiple
// times. Must be called before the events consumer exits to prevent Run() from
// blocking on a send into an unread channel.
func (c *Controller) Stop() {
	c.stopOnce.Do(func() { close(c.done) })
}

// State returns a pointer to the controller's TmuxState.
func (c *Controller) State() *TmuxState {
	return &c.state
}

// Commands returns the controller's CommandWriter.
func (c *Controller) Commands() *CommandWriter {
	return c.cmds
}

// internalBufSize is the capacity of the staging channel between the PTY reader
// and the dispatcher goroutine. 8192 events is enough to absorb a sendStateSync
// write (which can hold writeMu for several hundred milliseconds while sending
// thousands of lines of captured history) without the PTY reader stalling.
const internalBufSize = 8192

// Run reads events from the reader, applies them to state, and forwards
// them to the events channel. Returns nil on io.EOF.
//
// # Two-goroutine architecture
//
// The PTY reader (this goroutine) MUST NEVER block on sending to the external
// events channel. If it does, it stops draining the kernel PTY read buffer.
// When that buffer fills, tmux's event loop stalls on its own stdout write,
// which prevents tmux from reading new stdin input — including our send-keys
// commands — so keyboard input silently freezes.
//
// To decouple PTY drainage from the (potentially slow) event consumer:
//
//   - This goroutine reads from the PTY and sends to an internal staging
//     channel with a NON-BLOCKING send. The staging channel has enough
//     headroom (internalBufSize) that drops never occur in normal interactive
//     use; overflow is a safety valve for pathological conditions.
//
//   - A dispatcher goroutine reads from the staging channel and forwards to
//     c.events with a BLOCKING send (correct backpressure to the consumer).
//     The dispatcher is allowed to block because it is not the PTY reader.
func (c *Controller) Run() error {
	defer close(c.events)

	er := NewEventReader(bufio.NewReader(c.reader))

	// internal is the staging channel between this goroutine (PTY reader) and
	// the dispatcher below. The PTY reader sends here non-blocking so it can
	// never be stalled by a slow external consumer.
	internal := make(chan Event, internalBufSize)

	// Dispatcher goroutine: forwards events from internal to the external
	// c.events channel with blocking semantics (backpressure to wireEvents).
	// This goroutine IS allowed to block on c.events — it is not the PTY reader.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case ev, ok := <-internal:
				if !ok {
					return // staging channel closed — PTY reader is done
				}
				select {
				case c.events <- ev:
				case <-c.done:
					return
				}
			case <-c.done:
				return
			}
		}
	}()

	// PTY reader loop — MUST NOT block. A non-blocking send to internal keeps
	// the PTY always drained regardless of consumer speed.
	var runErr error
	for {
		ev, err := er.ReadEvent()
		if err != nil {
			if err != io.EOF {
				runErr = fmt.Errorf("controller run: %w", err)
			}
			break
		}
		c.applyEvent(ev)

		// Non-blocking send to the staging channel. Drop only if internal is
		// full, which requires internalBufSize undelivered events — far beyond
		// normal interactive load. Structural events missed here are recovered
		// by the 5-second periodic state sync; output events are visual-only
		// and will reappear on the next capture-pane replay.
		select {
		case internal <- ev:
		default:
			// safety valve: drop rather than stall PTY drainage
		}
	}

	close(internal)
	wg.Wait()
	return runErr
}

// applyEvent dispatches the event to the appropriate state mutation method.
func (c *Controller) applyEvent(ev Event) {
	switch e := ev.(type) {
	case SessionChangedEvent:
		c.state.ApplySessionChanged(e.SessionID, e.Name)
	case WindowAddEvent:
		c.state.ApplyWindowAdd(e.WindowID)
	case WindowCloseEvent:
		c.state.ApplyWindowClose(e.WindowID)
	case WindowRenamedEvent:
		c.state.ApplyWindowRenamed(e.WindowID, e.Name)
	case LayoutChangeEvent:
		c.state.ApplyLayoutChange(e.WindowID, e.Layout)
	case SessionWindowChangedEvent:
		c.state.ApplySessionWindowChanged(e.SessionID, e.WindowID)
	case WindowPaneChangedEvent:
		c.state.ApplyWindowPaneChanged(e.WindowID, e.PaneID)
	case SessionRenamedEvent:
		c.state.ApplySessionRenamed(e.Name)
	case OutputEvent, PaneModeChangedEvent, CommandResultEvent:
		// These don't mutate state
	}
}

func isOctal(b byte) bool {
	return b >= '0' && b <= '7'
}

func unescapeOctal(s string) []byte {
	if strings.IndexByte(s, '\\') < 0 {
		if len(s) == 0 {
			return nil
		}
		return []byte(s)
	}

	buf := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) && isOctal(s[i+1]) && isOctal(s[i+2]) && isOctal(s[i+3]) {
			d1 := s[i+1] - '0'
			d2 := s[i+2] - '0'
			d3 := s[i+3] - '0'
			buf = append(buf, d1*64+d2*8+d3)
			i += 3
		} else {
			buf = append(buf, s[i])
		}
	}
	return buf
}