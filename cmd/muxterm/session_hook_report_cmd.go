package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

func runSessionHookReport(args []string) error {
	fs := flag.NewFlagSet("session hook-report", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm session hook-report")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Queue one versioned JSON hook report read from stdin.")
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("session hook-report reads JSON from stdin and accepts no arguments")
	}
	body, err := io.ReadAll(io.LimitReader(os.Stdin, sessiond.MaxHookReportBytes+1))
	if err != nil {
		return fmt.Errorf("read hook report: %w", err)
	}
	receipt, err := sessiond.QueueHookReport(body)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(receipt)
}
