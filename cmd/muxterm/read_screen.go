package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
)

// readScreenJSON is the --json output shape for `muxterm read-screen`.
type readScreenJSON struct {
	PaneID      int      `json:"paneId"`
	WorkspaceID string   `json:"workspaceId"`
	Scrollback  bool     `json:"scrollback"`
	Text        string   `json:"text,omitempty"`
	Lines       []string `json:"lines,omitempty"`
	StartLine   *uint64  `json:"startLine,omitempty"`
	NextCursor  *uint64  `json:"nextCursor,omitempty"`
}

func runReadScreen(args []string) error {
	fs := flag.NewFlagSet("read-screen", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	scrollback := fs.Bool("scrollback", false, "read scrolled-off history instead of the current viewport")
	cursor := fs.Int64("cursor", -1, "absolute line-sequence cursor to page back from (default: most recent history)")
	limit := fs.Int("limit", 0, "max lines to return with --scrollback (default 500, capped at 5000)")
	workspace := fs.String("workspace", "", "workspace id owning the pane (default: search all workspaces)")
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm read-screen <pane-id> [flags]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Print a pane's current screen, or a page of its scrolled-off history.")
		fmt.Fprintln(os.Stdout, "Pages walk backward: pass the previous call's next-cursor to --cursor")
		fmt.Fprintln(os.Stdout, "until no next-cursor is reported.")
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
	if fs.NArg() < 1 {
		fs.Usage()
		return fmt.Errorf("read-screen requires a pane id")
	}
	paneID, err := strconv.Atoi(fs.Arg(0))
	if err != nil {
		return fmt.Errorf("invalid pane id %q: %v", fs.Arg(0), err)
	}

	return withDeadline(func() error {
		c, err := dialDaemon()
		if err != nil {
			return err
		}
		defer func() { _ = c.Close() }()

		wsID, err := attachForPane(c, *workspace, paneID)
		if err != nil {
			return err
		}

		if !*scrollback {
			snap, err := c.ScreenSnapshot(paneID)
			if err != nil {
				return err
			}
			if *asJSON {
				return printJSON(readScreenJSON{PaneID: paneID, WorkspaceID: wsID, Text: snap.Text})
			}
			fmt.Println(snap.Text)
			return nil
		}

		var cur *uint64
		if *cursor >= 0 {
			v := uint64(*cursor)
			cur = &v
		}
		lines, start, next, err := c.ScrollbackPage(paneID, cur, *limit)
		if err != nil {
			return err
		}
		if *asJSON {
			s := start
			return printJSON(readScreenJSON{
				PaneID:      paneID,
				WorkspaceID: wsID,
				Scrollback:  true,
				Lines:       lines,
				StartLine:   &s,
				NextCursor:  next,
			})
		}
		for _, ln := range lines {
			fmt.Println(ln)
		}
		if next != nil {
			fmt.Fprintf(os.Stderr, "start-line %d, %d lines, next-cursor %d (pass --cursor %d for the page before this one)\n",
				start, len(lines), *next, *next)
		} else {
			fmt.Fprintf(os.Stderr, "start-line %d, %d lines, next-cursor none (oldest retained line reached)\n",
				start, len(lines))
		}
		return nil
	})
}
