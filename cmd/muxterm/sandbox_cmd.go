package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"

	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/sandboxazure"
)

func runSandbox(args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		printSandboxUsage()
		return nil
	}
	cfg, err := sandboxazure.LoadConfig(config.DefaultPath())
	if err != nil {
		return err
	}
	controller, err := sandboxazure.NewController(cfg, sandboxazure.AzureProviderFactory)
	if err != nil {
		return err
	}
	ctx := context.Background()
	switch args[0] {
	case "list":
		if len(args) != 1 {
			return errors.New("usage: muxterm sandbox list")
		}
		value, err := controller.List(ctx)
		return printSandbox(value, err)
	case "describe", "status":
		if len(args) != 2 {
			return fmt.Errorf("usage: muxterm sandbox %s <handle>", args[0])
		}
		value, err := controller.Describe(ctx, args[1])
		return printSandbox(value, err)
	case "create":
		fs := flag.NewFlagSet("sandbox create", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		profile := fs.String("profile", "", "allowlisted profile name")
		requestID := fs.String("request-id", "", "stable UUID for idempotent retry")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if *profile == "" || *requestID == "" || fs.NArg() != 0 {
			return errors.New("usage: muxterm sandbox create --profile <allowlisted-profile> --request-id <uuid>")
		}
		value, err := controller.Create(ctx, *profile, *requestID)
		return printSandbox(value, err)
	case "stop", "resume", "destroy":
		if len(args) < 3 {
			return fmt.Errorf("usage: muxterm sandbox %s <handle> <generation> --request-id <uuid>", args[0])
		}
		generation, err := strconv.ParseUint(args[2], 10, 64)
		if err != nil || generation == 0 {
			return errors.New("sandbox generation must be a positive integer")
		}
		fs := flag.NewFlagSet("sandbox "+args[0], flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		requestID := fs.String("request-id", "", "stable UUID for idempotent retry")
		if err := fs.Parse(args[3:]); err != nil {
			return err
		}
		if *requestID == "" || fs.NArg() != 0 {
			return fmt.Errorf("usage: muxterm sandbox %s <handle> <generation> --request-id <uuid>", args[0])
		}
		var value sandboxazure.View
		switch args[0] {
		case "stop":
			value, err = controller.Stop(ctx, args[1], generation, *requestID)
		case "resume":
			value, err = controller.Resume(ctx, args[1], generation, *requestID)
		case "destroy":
			value, err = controller.Destroy(ctx, args[1], generation, *requestID)
		}
		return printSandbox(value, err)
	case "reconcile":
		if len(args) < 3 {
			return errors.New("usage: muxterm sandbox reconcile <handle> <generation> --request-id <uuid>")
		}
		generation, err := strconv.ParseUint(args[2], 10, 64)
		if err != nil || generation == 0 {
			return errors.New("sandbox generation must be a positive integer")
		}
		fs := flag.NewFlagSet("sandbox reconcile", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		requestID := fs.String("request-id", "", "stable UUID for idempotent retry")
		if err := fs.Parse(args[3:]); err != nil {
			return err
		}
		if *requestID == "" || fs.NArg() != 0 {
			return errors.New("usage: muxterm sandbox reconcile <handle> <generation> --request-id <uuid>")
		}
		value, err := controller.Reconcile(ctx, args[1], generation, *requestID)
		return printSandbox(value, err)
	case "attach":
		if len(args) < 3 {
			return errors.New("usage: muxterm sandbox attach <handle> <generation> --request-id <uuid>")
		}
		generation, err := strconv.ParseUint(args[2], 10, 64)
		if err != nil || generation == 0 {
			return errors.New("sandbox generation must be a positive integer")
		}
		fs := flag.NewFlagSet("sandbox attach", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		requestID := fs.String("request-id", "", "stable UUID for idempotent retry")
		if err := fs.Parse(args[3:]); err != nil {
			return err
		}
		if *requestID == "" || fs.NArg() != 0 {
			return errors.New("usage: muxterm sandbox attach <handle> <generation> --request-id <uuid>")
		}
		return controller.Attach(args[1], generation, *requestID)
	default:
		return fmt.Errorf("unknown sandbox command %q", args[0])
	}
}

func printSandbox(value any, err error) error {
	// Ambiguous/failed operations still return their durable opaque handle so
	// the operator can reconcile them. Preserve the non-zero exit/error while
	// never printing private provider data.
	if view, ok := value.(sandboxazure.View); ok && view.Handle != "" {
		encoded, encodeErr := json.MarshalIndent(view, "", "  ")
		if encodeErr != nil {
			return errors.New("encode sandbox result")
		}
		fmt.Println(string(encoded))
		return err
	}
	if err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return errors.New("encode sandbox result")
	}
	fmt.Println(string(encoded))
	return nil
}

func printSandboxUsage() {
	fmt.Fprintln(os.Stdout, "Usage: muxterm sandbox <command>")
	fmt.Fprintln(os.Stdout, "  list")
	fmt.Fprintln(os.Stdout, "  describe|status <handle>")
	fmt.Fprintln(os.Stdout, "  create --profile <allowlisted-profile> --request-id <uuid>")
	fmt.Fprintln(os.Stdout, "  stop|resume|destroy <handle> <generation> --request-id <uuid>")
	fmt.Fprintln(os.Stdout, "  reconcile <handle> <generation> --request-id <uuid>")
	fmt.Fprintln(os.Stdout, "  attach <handle> <generation> --request-id <uuid>  (explicitly unsupported in v1)")
}
