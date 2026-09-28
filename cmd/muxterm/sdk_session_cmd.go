package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"text/tabwriter"
	"time"
)

// `muxterm sdk-session` -- drive a session through a harness SDK.
//
// WHY THIS IS A SEPARATE VERB from `muxterm session send`. They look similar
// and they are not the same operation:
//
//   - `session send` addresses a session running behind a PTY. It delivers by
//     running a one-shot subprocess against the harness's resume path, and it
//     records the outcome as "uncertain" whenever that subprocess fails,
//     because an exit code cannot distinguish "the agent never saw it" from
//     "the agent saw it and the wrapper died afterwards"
//     (session_send_cmd.go). The prompt is deliberately never retried.
//
//   - `sdk-session send` addresses a session the daemon holds open over
//     JSON-RPC. Delivery returns a TURN ID the harness minted. There is no
//     uncertain outcome to record: the harness either returned a receipt or
//     returned an error.
//
// Both exist. Nothing here changes, replaces or degrades the first one.

func runSDKSession(args []string) error {
	if len(args) == 0 {
		sdkSessionUsage()
		return errors.New("sdk-session requires a subcommand")
	}
	switch args[0] {
	case "start":
		return runSDKSessionStart(args[1:])
	case "send":
		return runSDKSessionSend(args[1:])
	case "resume":
		return runSDKSessionResume(args[1:])
	case "list":
		return runSDKSessionList(args[1:])
	case "close":
		return runSDKSessionClose(args[1:])
	case "-h", "--help", "help":
		sdkSessionUsage()
		return nil
	default:
		sdkSessionUsage()
		return fmt.Errorf("unknown sdk-session subcommand %q", args[0])
	}
}

func sdkSessionUsage() {
	fmt.Fprintln(os.Stdout, "Usage: muxterm sdk-session <start|send|list|close> [options]")
	fmt.Fprintln(os.Stdout, "")
	fmt.Fprintln(os.Stdout, "Drive a session through a harness SDK rather than through a terminal.")
	fmt.Fprintln(os.Stdout, "The daemon owns the session, so it outlives this command and survives a")
	fmt.Fprintln(os.Stdout, "daemon restart as a durable record.")
	fmt.Fprintln(os.Stdout, "")
	fmt.Fprintln(os.Stdout, "  start  --harness codex [--cwd DIR] [--name NAME]")
	fmt.Fprintln(os.Stdout, "  send   <session-id> --prompt TEXT   (resumes the thread first if detached)")
	fmt.Fprintln(os.Stdout, "  resume <session-id>                 (reattach without delivering)")
	fmt.Fprintln(os.Stdout, "  list   [--json]")
	fmt.Fprintln(os.Stdout, "  close  <session-id>")
}

func runSDKSessionStart(args []string) error {
	fs := flag.NewFlagSet("sdk-session start", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	harness := fs.String("harness", "codex", "harness to start (SDK-backed: codex)")
	cwd := fs.String("cwd", "", "working directory for the session (default: current)")
	name := fs.String("name", "", "human-readable session name")
	asJSON := fs.Bool("json", false, "print the created session as JSON")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	dir := *cwd
	if dir == "" {
		dir, _ = os.Getwd()
	}
	c, err := dialDaemon()
	if err != nil {
		return err
	}
	defer c.Close()
	sessionID, threadID, err := c.SDKSessionStart(*harness, dir, *name)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(map[string]string{
			"sessionId": sessionID, "threadId": threadID, "harness": *harness, "cwd": dir,
		})
	}
	fmt.Printf("session %s started\n", sessionID)
	fmt.Printf("  harness  %s\n", *harness)
	fmt.Printf("  thread   %s\n", threadID)
	fmt.Printf("  cwd      %s\n", dir)
	return nil
}

func runSDKSessionSend(args []string) error {
	fs := flag.NewFlagSet("sdk-session send", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	prompt := fs.String("prompt", "", "turn text to deliver")
	asJSON := fs.Bool("json", false, "print the receipt as JSON")
	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("sdk-session send requires exactly one session id")
	}
	if *prompt == "" {
		return errors.New("--prompt is required")
	}
	c, err := dialDaemon()
	if err != nil {
		return err
	}
	defer c.Close()
	turnID, turnStatus, resumed, err := c.SDKSessionSend(fs.Arg(0), *prompt)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(map[string]any{
			"sessionId": fs.Arg(0), "turnId": turnID, "turnStatus": turnStatus,
			"delivery": "acknowledged", "resumed": resumed,
		})
	}
	// The receipt, printed as a receipt. "acknowledged" is not a hope here:
	// it is the harness having returned this turn id from turn/start.
	fmt.Printf("delivery acknowledged by harness\n")
	fmt.Printf("  session     %s\n", fs.Arg(0))
	fmt.Printf("  turn        %s\n", turnID)
	fmt.Printf("  turn status %s\n", turnStatus)
	if resumed {
		// Said out loud. The session had no live connection when this
		// command ran, so the daemon reopened the harness thread before
		// delivering -- the turn landed in the SAME conversation, not a new
		// one, and a reader is entitled to know that happened.
		fmt.Printf("  resumed     yes (harness thread reopened before delivery)\n")
	}
	return nil
}

func runSDKSessionResume(args []string) error {
	fs := flag.NewFlagSet("sdk-session resume", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	asJSON := fs.Bool("json", false, "print the resumption as JSON")
	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("sdk-session resume requires exactly one session id")
	}
	c, err := dialDaemon()
	if err != nil {
		return err
	}
	defer c.Close()
	threadID, resumed, err := c.SDKSessionResume(fs.Arg(0))
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(map[string]any{
			"sessionId": fs.Arg(0), "threadId": threadID, "resumed": resumed,
		})
	}
	if resumed {
		fmt.Printf("session %s resumed\n", fs.Arg(0))
	} else {
		// Not a failure and not a no-op dressed as success: the session was
		// already attached, so there was nothing to reopen.
		fmt.Printf("session %s was already live; nothing to resume\n", fs.Arg(0))
	}
	fmt.Printf("  thread   %s\n", threadID)
	return nil
}

func runSDKSessionList(args []string) error {
	fs := flag.NewFlagSet("sdk-session list", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	c, err := dialDaemon()
	if err != nil {
		return err
	}
	defer c.Close()
	recs, err := c.SDKSessionList()
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(recs)
	}
	if len(recs) == 0 {
		fmt.Println("no SDK-backed sessions")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "SESSION\tHARNESS\tSTATE\tTURNS\tRESUMES\tLAST TURN\tTHREAD\tCREATED")
	for _, r := range recs {
		fmt.Fprintf(w, "%s\t%s\t%s\t%d\t%d\t%s\t%s\t%s\n",
			r.SessionID, r.Harness, r.State, r.TurnCount, r.ResumeCount,
			shortID(r.LastTurnID), shortID(r.ThreadID),
			time.Unix(r.CreatedAt, 0).Format(time.RFC3339))
	}
	return w.Flush()
}

func runSDKSessionClose(args []string) error {
	fs := flag.NewFlagSet("sdk-session close", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("sdk-session close requires exactly one session id")
	}
	c, err := dialDaemon()
	if err != nil {
		return err
	}
	defer c.Close()
	if err := c.SDKSessionClose(fs.Arg(0)); err != nil {
		return err
	}
	fmt.Printf("session %s closed (durable record retained)\n", fs.Arg(0))
	return nil
}

// shortID trims an id for column display without losing its identity.
func shortID(id string) string {
	if len(id) <= 8 {
		if id == "" {
			return "-"
		}
		return id
	}
	return id[:8]
}
