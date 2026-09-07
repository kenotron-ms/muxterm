package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/charmbracelet/x/term"

	"github.com/kenotron-ms/muxterm/internal/cos"
)

// cosDefaultTurnTimeout bounds one turn end to end. Generous: a chief-of-staff
// turn may spawn sub-agents and run tools for minutes.
const cosDefaultTurnTimeout = 10 * time.Minute

// runCos implements `muxterm cos`, the terminal face of the chief-of-staff
// sidecar. It exists so Stage 3 is provable WITHOUT a browser, which is the
// honest test of whether a chief of staff is useful at all (spec 3.3).
//
// Output discipline: the model's reply goes to stdout and nothing else does.
// Tool activity, prompts, and diagnostics go to stderr, so
// `muxterm cos "..." > reply.txt` yields a clean reply.
func runCos(args []string) error {
	fs := flag.NewFlagSet("cos", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	status := fs.Bool("status", false, "report sidecar status and exit")
	asJSON := fs.Bool("json", false, "with --status, print machine-readable JSON")
	defaultSessionID, _ := cos.ResolveSessionID("")
	sessionID := fs.String("session-id", defaultSessionID, "amplifier session id the sidecar owns")
	bundle := fs.String("bundle", "", "amplifier bundle name (default: the sidecar's own default)")
	cwd := fs.String("cwd", "", "working directory for the sidecar (default: current directory)")
	logLevel := fs.String("log-level", "info", "sidecar log level")
	python := fs.String("python", "", "python interpreter to run the sidecar with (default: $"+cos.EnvPython+", then the amplifier venv)")
	sidecar := fs.String("sidecar", "", "path to the sidecar main.py (default: $"+cos.EnvSidecar+", then discovery)")
	timeout := fs.Duration("timeout", cosDefaultTurnTimeout, "give up on the turn after this long")
	bootTimeout := fs.Duration("boot-timeout", cos.DefaultReadyTimeout, "give up if the sidecar has not booted in this long")
	yes := fs.Bool("yes", false, "approve every approval request without asking")
	verbose := fs.Bool("verbose", false, "echo supervisor diagnostics, sidecar logs, and thinking blocks")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm cos <message> [flags]")
		fmt.Fprintln(os.Stdout, "       muxterm cos --status [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Send one turn to muxterm and stream the reply.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "The sidecar keeps ONE amplifier session alive across turns, so a turn")
		fmt.Fprintln(os.Stdout, "costs a turn rather than a process boot. The session is an ordinary")
		fmt.Fprintln(os.Stdout, "amplifier session: 'amplifier resume "+defaultSessionID+"' reaches the")
		fmt.Fprintln(os.Stdout, "same conversation from a terminal.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "ONE sidecar owns a session. If the muxterm server (or another terminal)")
		fmt.Fprintln(os.Stdout, "already has one for this session, this command refuses rather than")
		fmt.Fprintln(os.Stdout, "starting a second: two processes writing one transcript erase each")
		fmt.Fprintln(os.Stdout, "other's turns. Pass --session-id for a separate conversation.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "The reply is printed to stdout; tool activity, approval prompts, and")
		fmt.Fprintln(os.Stdout, "diagnostics go to stderr.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "When a tool needs approval you are asked on the terminal. If stdin is")
		fmt.Fprintln(os.Stdout, "not a TTY the request is DENIED and the denial is reported, so a")
		fmt.Fprintln(os.Stdout, "scripted run can never silently approve something.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Flags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}

	if *status {
		return runCosStatus(*asJSON)
	}

	message := strings.TrimSpace(strings.Join(fs.Args(), " "))
	if message == "" {
		fs.Usage()
		return fmt.Errorf("cos requires a message (quote it if it contains spaces)")
	}

	// ONE SIDECAR PER SESSION. This is the whole reason the check is here and
	// not somewhere more elegant: cos.Supervisor's queue serializes turns
	// within ONE process, and two supervisors in two processes cannot see each
	// other's queue at all. Both would resume the same amplifier session and
	// both would write the WHOLE transcript back at turn end
	// (internal/cos/sidecar/main.py _save_session), so the second one to finish erases
	// whatever the first one added. That is the measured turn-erasure defect
	// this feature exists to fix; reaching it from the CLI would reintroduce it.
	//
	// Advisory by nature (a pid can be recycled, and there is a window between
	// this read and the spawn below), which is why it refuses on evidence of a
	// live owner rather than trying to take a lock. It costs nothing when no
	// sidecar is running, and it never starts one to find out.
	if st, err := cos.ReadState(""); err == nil && st.Alive() && st.SessionID == *sessionID {
		owner := st.OwnerPID
		if owner <= 0 {
			owner = st.PID
		}
		return fmt.Errorf("a sidecar already owns session %s (pid %d, supervised by pid %d) \u2014 "+
			"talk to it in the browser, or pass --session-id for a separate conversation",
			st.SessionID, st.PID, owner)
	}

	logger := newCosLogger(*verbose)
	sup := cos.New(cos.Config{
		SessionID: *sessionID,
		Bundle:    *bundle,
		Cwd:       *cwd,
		LogLevel:  *logLevel,
		Python:    *python,
		Script:    *sidecar,
		Logf:      logger.Printf,
	})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := sup.Start(ctx); err != nil {
		return err
	}
	defer sup.Close() //nolint:errcheck // the turn's own error is the one that matters

	// Subscribe BEFORE submitting so no event of this turn can be missed.
	sub := sup.Subscribe(0)
	defer sub.Close()

	bootCtx, cancelBoot := context.WithTimeout(ctx, *bootTimeout)
	defer cancelBoot()
	ready, err := sup.WaitReady(bootCtx)
	if err != nil {
		return fmt.Errorf("sidecar did not start: %w%s", err, logger.tail())
	}
	if *verbose {
		fmt.Fprintf(os.Stderr, "cos: session %s, bundle %s, %d tools, booted in %dms (resumed=%v)\n",
			ready.SessionID, ready.Bundle, ready.Tools, ready.BootMS, ready.Resumed)
	}

	turn := sup.Submit(message)
	r := &cosRenderer{
		reply:       os.Stdout,
		status:      os.Stderr,
		verbose:     *verbose,
		autoApprove: *yes,
		interactive: stdinIsTTY(),
		stdin:       bufio.NewReader(os.Stdin),
		sup:         sup,
		sub:         sub,
		turnID:      turn.ID,
	}

	turnCtx, cancelTurn := context.WithTimeout(ctx, *timeout)
	defer cancelTurn()

	for {
		select {
		case ev, ok := <-sub.C():
			if !ok {
				// The stream ended. The turn handle is authoritative, so wait
				// on it rather than guessing at an outcome here.
				return r.finish(turn, logger)
			}
			r.render(ev)

		case <-turn.Done():
			// Drain whatever is already buffered so the tail of the stream is
			// rendered before the terminal event is reported.
			r.drain(sub)
			return r.finish(turn, logger)

		case <-turnCtx.Done():
			r.newline()
			if errors.Is(turnCtx.Err(), context.DeadlineExceeded) {
				fmt.Fprintf(os.Stderr, "cos: turn exceeded %s; cancelling\n", *timeout)
			} else {
				fmt.Fprintln(os.Stderr, "cos: interrupted; cancelling turn")
			}
			_ = sup.Cancel(turn.ID)
			select {
			case <-turn.Done():
			case <-time.After(5 * time.Second):
			}
			return fmt.Errorf("turn %s did not complete: %w", turn.ID, turnCtx.Err())
		}
	}
}

// runCosStatus reports whether a sidecar is live, reading the status file the
// supervisor publishes. It deliberately does NOT start one: asking whether
// something is running must never be the thing that starts it.
//
// Exit status is 0 either way, matching `muxterm doctor`: "not running" is an
// answer, not a failure.
func runCosStatus(asJSON bool) error {
	path, pathErr := cos.StatePath()
	st, err := cos.ReadState(path)
	switch {
	case err != nil && os.IsNotExist(err):
		if asJSON {
			return printJSON(map[string]any{"running": false, "reason": "no status file"})
		}
		fmt.Println("cos sidecar: not running")
		if pathErr == nil {
			fmt.Printf("  status file: %s (absent)\n", path)
		}
		fmt.Println("  hint:        run 'muxterm cos \"hello\"' to start one")
		return nil
	case err != nil:
		return err
	}

	alive := st.Alive()
	if asJSON {
		return printJSON(map[string]any{
			"running":    alive,
			"pid":        st.PID,
			"ownerPid":   st.OwnerPID,
			"sessionId":  st.SessionID,
			"bundle":     st.Bundle,
			"tools":      st.Tools,
			"bootMs":     st.BootMS,
			"resumed":    st.Resumed,
			"startedAt":  st.StartedAt,
			"uptimeSecs": st.Uptime().Seconds(),
			"python":     st.Python,
			"script":     st.Script,
		})
	}

	if !alive {
		fmt.Println("cos sidecar: not running (stale status file)")
		fmt.Printf("  status file: %s\n", path)
		fmt.Printf("  last pid:    %d (gone)\n", st.PID)
		fmt.Printf("  session:     %s\n", st.SessionID)
		return nil
	}
	fmt.Println("cos sidecar: running")
	fmt.Printf("  session:     %s\n", st.SessionID)
	fmt.Printf("  pid:         %d (supervised by pid %d)\n", st.PID, st.OwnerPID)
	fmt.Printf("  uptime:      %s\n", st.Uptime())
	if st.Bundle != "" {
		fmt.Printf("  bundle:      %s\n", st.Bundle)
	}
	if st.Tools > 0 {
		fmt.Printf("  tools:       %d\n", st.Tools)
	}
	if st.BootMS > 0 {
		fmt.Printf("  boot:        %dms (resumed=%v)\n", st.BootMS, st.Resumed)
	}
	if st.Python != "" {
		fmt.Printf("  python:      %s\n", st.Python)
	}
	if st.Script != "" {
		fmt.Printf("  sidecar:     %s\n", st.Script)
	}
	return nil
}

// cosRenderer turns the event stream into terminal output.
type cosRenderer struct {
	reply  io.Writer // the model's words, and nothing else
	status io.Writer // tool activity, prompts, diagnostics

	verbose     bool
	autoApprove bool
	interactive bool
	stdin       *bufio.Reader
	sup         *cos.Supervisor
	sub         *cos.Subscription
	turnID      string

	streamed    strings.Builder
	atLineStart bool
	sawText     bool
}

// render handles one event. Terminal events are deliberately NOT rendered
// here: the turn handle is the authority on completion (a subscription may
// drop), so finish owns the ending and there is exactly one place that prints
// a final response.
func (r *cosRenderer) render(ev cos.Event) {
	if ev.TurnID != "" && ev.TurnID != r.turnID {
		return // another turn's event; not ours to print
	}
	switch ev.Ev {
	case cos.EvDelta:
		if ev.Text == "" {
			return
		}
		fmt.Fprint(r.reply, ev.Text)
		r.streamed.WriteString(ev.Text)
		r.sawText = true
		r.atLineStart = strings.HasSuffix(ev.Text, "\n")

	case cos.EvThinking:
		if r.verbose && ev.Text != "" {
			r.newline()
			fmt.Fprintf(r.status, "  ~ %s\n", strings.TrimSpace(ev.Text))
		}

	case cos.EvToolStart:
		r.newline()
		fmt.Fprintf(r.status, "  > %s%s\n", ev.Name, argsSummary(ev))

	case cos.EvToolEnd:
		r.newline()
		mark := "\u2713"
		if !ev.OK {
			mark = "\u2717"
		}
		line := fmt.Sprintf("  %s %s", mark, ev.Summary)
		if ev.Summary == "" {
			line = fmt.Sprintf("  %s done", mark)
		}
		if ev.MS > 0 {
			line += fmt.Sprintf(" (%dms)", ev.MS)
		}
		fmt.Fprintln(r.status, line)

	case cos.EvApprovalRequest:
		r.newline()
		r.approve(ev)

	case cos.EvError:
		if ev.IsTerminal() {
			return // finish reports it
		}
		r.newline()
		fmt.Fprintf(r.status, "  ! %s: %s\n", ev.Code, ev.Message)
	}
}

// approve answers an approval_request. An approval_request BLOCKS the turn
// until it is answered (2.4 law 3), so every path here must answer.
func (r *cosRenderer) approve(ev cos.Event) {
	detail := ev.Detail
	if detail == "" {
		detail = "(no detail)"
	}
	fmt.Fprintf(r.status, "\n  approval requested: %s\n    %s\n", ev.Tool, detail)

	if r.autoApprove {
		fmt.Fprintln(r.status, "  approved automatically (--yes)")
		r.send(ev.RequestID, true, "approved by --yes")
		return
	}
	if !r.interactive {
		// Fail closed. A non-interactive run that auto-approved would be a
		// way to run an unreviewed command by piping into muxterm.
		fmt.Fprintln(r.status, "  DENIED: stdin is not a TTY, so nobody can answer. Re-run in a terminal, or pass --yes.")
		r.send(ev.RequestID, false, "denied: muxterm cos stdin is not a TTY")
		return
	}

	fmt.Fprint(r.status, "  approve? [y/N]: ")
	line, err := r.stdin.ReadString('\n')
	if err != nil && line == "" {
		// The TTY went away mid-prompt (Ctrl-D, a closed terminal). Deny:
		// silence is not consent, and the turn is blocked until we answer.
		fmt.Fprintf(r.status, "\n  DENIED: no answer could be read from the terminal (%v)\n", err)
		r.send(ev.RequestID, false, "denied: no answer available")
		return
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	approved := answer == "y" || answer == "yes"
	if approved {
		fmt.Fprintln(r.status, "  approved")
		r.send(ev.RequestID, true, "approved at the muxterm cos prompt")
		return
	}
	fmt.Fprintln(r.status, "  denied")
	r.send(ev.RequestID, false, "denied at the muxterm cos prompt")
}

func (r *cosRenderer) send(requestID string, approved bool, reason string) {
	if err := r.sup.Approve(requestID, approved, reason); err != nil {
		fmt.Fprintf(r.status, "  ! could not deliver the approval decision: %v\n", err)
	}
}

// drain renders every event already buffered, without blocking.
func (r *cosRenderer) drain(sub *cos.Subscription) {
	for {
		select {
		case ev, ok := <-sub.C():
			if !ok {
				return
			}
			r.render(ev)
		default:
			return
		}
	}
}

// newline ends a partially written delta line before status output, so a
// tool line never lands in the middle of a sentence.
func (r *cosRenderer) newline() {
	if r.sawText && !r.atLineStart {
		fmt.Fprintln(r.reply)
		r.atLineStart = true
	}
}

// finish prints the ending exactly once and maps it onto an exit status.
//
// turn_end.response is authoritative (2.4 law 4): deltas are advisory and may
// have been dropped, so the streamed text is reconciled against the full
// response rather than trusted.
func (r *cosRenderer) finish(turn *cos.Turn, logger *cosLogger) error {
	ev, err := turn.Result()

	if err == nil {
		streamed := r.streamed.String()
		switch {
		case streamed == ev.Response:
			// Streamed exactly; nothing left to print.
		case strings.HasPrefix(ev.Response, streamed):
			fmt.Fprint(r.reply, ev.Response[len(streamed):])
			r.sawText = r.sawText || ev.Response != ""
			r.atLineStart = strings.HasSuffix(ev.Response, "\n")
		default:
			r.newline()
			fmt.Fprintln(r.status, "  ! streamed text diverged from the final response; printing the full response")
			fmt.Fprint(r.reply, ev.Response)
			r.atLineStart = strings.HasSuffix(ev.Response, "\n")
		}
		r.newline()
		if r.verbose {
			fmt.Fprintf(r.status, "cos: turn %s finished in %dms cost=%s (dropped %d events)\n",
				ev.TurnID, ev.MS, costOrDash(ev), r.sub.Dropped())
		}
		if dropped := r.sub.Dropped(); dropped > 0 && !r.verbose {
			fmt.Fprintf(r.status, "cos: %d stream events were dropped (slow terminal); the reply above is still complete\n", dropped)
		}
		return nil
	}

	r.newline()
	return fmt.Errorf("turn %s failed: %w%s", turn.ID, err, logger.tail())
}

func costOrDash(ev cos.Event) string {
	if ev.CostUSD == "" {
		return "-"
	}
	return ev.CostUSD.String()
}

// argsSummary renders a tool call's arguments compactly for a status line.
func argsSummary(ev cos.Event) string {
	if len(ev.Args) == 0 || string(ev.Args) == "{}" || string(ev.Args) == "null" {
		return ""
	}
	s := strings.Join(strings.Fields(string(ev.Args)), " ")
	const max = 120
	if len(s) > max {
		s = s[:max] + "..."
	}
	return " " + s
}

// stdinIsTTY reports whether a human can answer a prompt.
//
// This is a real isatty (a TCGETS ioctl), not a stat of the file mode:
// /dev/null is a character device too, so the mode check every CLI reaches for
// first would call `muxterm cos "..." < /dev/null` interactive and prompt a
// reader that is not there. term.IsTerminal is already in the module graph via
// the terminal stack, so this costs no new dependency.
func stdinIsTTY() bool {
	return term.IsTerminal(os.Stdin.Fd())
}

// cosLogger routes supervisor diagnostics. Quiet by default (they would bury
// the reply) but retained, so a failure can show what the supervisor saw
// instead of just "it did not start".
type cosLogger struct {
	verbose bool
	mu      sync.Mutex
	lines   []string
}

func newCosLogger(verbose bool) *cosLogger { return &cosLogger{verbose: verbose} }

func (l *cosLogger) Printf(format string, v ...any) {
	line := fmt.Sprintf(format, v...)
	if l.verbose {
		fmt.Fprintln(os.Stderr, line)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, line)
	if len(l.lines) > 200 {
		l.lines = l.lines[len(l.lines)-200:]
	}
}

// tail renders the retained diagnostics for an error message. It returns "" in
// verbose mode, where everything was already printed live.
//
// Sidecar stderr is already in here: the supervisor routes every stderr line
// through Logf, so these lines interleave the supervisor's view with the
// sidecar's own log channel (2.1) in the order they happened.
func (l *cosLogger) tail() string {
	if l.verbose {
		return ""
	}
	l.mu.Lock()
	lines := append([]string(nil), l.lines...)
	l.mu.Unlock()

	const keep = 20
	if len(lines) > keep {
		lines = lines[len(lines)-keep:]
	}
	if len(lines) == 0 {
		return ""
	}
	return "\n\nsidecar diagnostics (last " + fmt.Sprint(len(lines)) + " lines):\n  " +
		strings.Join(lines, "\n  ")
}
