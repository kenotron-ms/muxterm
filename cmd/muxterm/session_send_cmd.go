package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/mcp"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

func runSessionSend(args []string) error {
	fs := flag.NewFlagSet("session send", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	prompt := fs.String("prompt", "", "user message to send")
	clientRef := fs.String("client-ref", "", "stable idempotency key for this submission")
	cursor := fs.String("cursor", "", "reject unless this durable transcript cursor is current")
	asJSON := fs.Bool("json", false, "print the durable turn record as JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm session send <session-id> --prompt TEXT --client-ref ID [--cursor CURSOR] [--json]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Durably admits one native-resume turn. Reusing client-ref never dispatches twice.")
		fmt.Fprintln(os.Stdout, "Approval brokerage and terminal takeover remain disabled until their real gates pass.")
	}
	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return errors.New("session send requires exactly one session id")
	}
	row, nativeID, err := sessiond.LookupHookSession(fs.Arg(0))
	if err != nil {
		return err
	}
	turn, duplicate, err := mcp.AdmitManagedTurn(row, nativeID, *prompt, *clientRef, *cursor)
	if err != nil {
		return err
	}
	if duplicate {
		turn = mcp.ReconcileManagedTurn(turn)
		if *asJSON {
			return printJSON(turn)
		}
		fmt.Printf("%s: %s (duplicate admission; not dispatched)\n", turn.ClientRef, turn.Status)
		return nil
	}
	release, err := mcp.AcquireManagedWriter(row.SessionID)
	if err != nil {
		turn, _ = mcp.UpdateManagedTurn(turn, "rejected", err.Error())
		return err
	}
	defer release()
	turn, err = mcp.UpdateManagedTurn(turn, "dispatching", "")
	if err != nil {
		return err
	}
	cmd, cleanup, err := managedResumeCommand(row, nativeID, *prompt)
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		turn, _ = mcp.UpdateManagedTurn(turn, "failed", err.Error())
		return err
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err = cmd.Run()
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		turn, _ = mcp.UpdateManagedTurn(turn, "uncertain", detail)
		return fmt.Errorf("managed dispatch outcome is uncertain; prompt was not retried: %s", detail)
	}
	turn, err = mcp.UpdateManagedTurn(turn, "completed", "")
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(turn)
	}
	if out := strings.TrimSpace(stdout.String()); out != "" {
		fmt.Fprintln(os.Stdout, out)
	}
	return nil
}

func managedResumeCommand(row sessiond.SessionState, nativeID, prompt string) (*exec.Cmd, func(), error) {
	self, err := os.Executable()
	if err != nil {
		return nil, nil, err
	}
	switch row.Harness {
	case sessiond.HarnessClaude:
		claude, err := exec.LookPath("claude")
		if err != nil {
			return nil, nil, err
		}
		plugin, err := materializeClaudePlugin()
		if err != nil {
			return nil, nil, err
		}
		cmd := exec.Command(claude, "--plugin-dir", plugin, "--print", "--output-format", "text", "--permission-mode", "manual", "--permission-prompts", "none", "--resume", nativeID, prompt)
		cmd.Env = append(os.Environ(), "MUXTERM_CLAUDE_BRIDGE="+self)
		return cmd, func() { _ = os.RemoveAll(plugin) }, nil
	case sessiond.HarnessCodex:
		codex, err := exec.LookPath("codex")
		if err != nil {
			return nil, nil, err
		}
		cwd := row.Project
		if cwd == "" {
			cwd, _ = os.Getwd()
		}
		hooks, err := sessiond.CodexRichHookArgs(codex, self, cwd)
		if err != nil {
			return nil, nil, err
		}
		argv := append([]string{"exec", "resume"}, hooks...)
		argv = append(argv, "--json", nativeID, prompt)
		cmd := exec.Command(codex, argv...)
		cmd.Dir = cwd
		cmd.Env = append(os.Environ(), sessiond.CodexHookBridgeEnv+"="+self, sessiond.CodexRichReportingEnv+"=1", "MUXTERM_CODEX_PID="+strconv.Itoa(os.Getpid()))
		return cmd, nil, nil
	case sessiond.HarnessAmplifier:
		cmd := exec.Command(self, "amplifier", "run", prompt, "--resume", nativeID, "--mode", "single", "--output-format", "text")
		cmd.Env = os.Environ()
		return cmd, nil, nil
	default:
		return nil, nil, fmt.Errorf("managed chat is unavailable for harness %q", row.Harness)
	}
}
