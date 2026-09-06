package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/sshconfig"
)

// runRemote dispatches the `muxterm remote` subcommand tree, which manages the
// ssh config entries muxterm uses to reach a remote sessiond.
//
// This file is CLI ONLY: argument parsing and printing. Every byte that touches
// the ssh config goes through internal/sshconfig, so the same editing behavior
// (markers, backup, atomic replace, refusal to hijack a hand-written Host) is
// available to anything else that needs it without going through argv.
func runRemote(args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(os.Stdout, "Usage: muxterm remote <command>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Manage the ssh config entries muxterm uses to reach remote machines.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Commands:")
		fmt.Fprintln(os.Stdout, "  add <name> --host H     Add or update a muxterm-managed ssh config entry")
		fmt.Fprintln(os.Stdout, "  list                    List managed entries and other hosts in the config")
		fmt.Fprintln(os.Stdout, "  remove <name>           Delete a muxterm-managed entry")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Entries are written between '# >>> muxterm remote: <name> >>>' markers in")
		fmt.Fprintln(os.Stdout, "~/.ssh/config. Everything outside those markers is left exactly as it is,")
		fmt.Fprintln(os.Stdout, "and the file is backed up before the first change of each run.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintf(os.Stdout, "Set %s to edit a different file (testing).\n", sshconfig.EnvPath)
		return nil
	}
	switch args[0] {
	case "add":
		return runRemoteAdd(args[1:])
	case "list":
		return runRemoteList(args[1:])
	case "remove":
		return runRemoteRemove(args[1:])
	default:
		return fmt.Errorf("unknown remote command %q\n\nRun 'muxterm remote --help' for usage.", args[0])
	}
}

// remoteManager resolves which ssh config to edit and returns a manager for it.
func remoteManager() (*sshconfig.Manager, error) {
	path, err := sshconfig.DefaultPath()
	if err != nil {
		return nil, err
	}
	return sshconfig.New(path), nil
}

// reportBackup prints the backup path if one was taken.
//
// It is called on BOTH the success and failure paths, because a failed write is
// exactly when the user most needs to know where their previous config went.
func reportBackup(m *sshconfig.Manager) {
	if p := m.BackupPath(); p != "" {
		fmt.Printf("backed up %s -> %s\n", m.Path(), p)
	}
}

func runRemoteAdd(args []string) error {
	fs := flag.NewFlagSet("remote add", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	host := fs.String("host", "", "hostname, IP, or tailnet name to connect to (required)")
	port := fs.Int("port", 0, "ssh port (omitted from the entry when unset, so ssh uses its default)")
	user := fs.String("user", "", "remote username (optional)")
	identity := fs.String("identity", "", "path to the private key to use (optional)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm remote add <name> --host <h> [--port <p>] [--user <u>] [--identity <path>]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Add a muxterm-managed entry to your ssh config, or update the one that is")
		fmt.Fprintln(os.Stdout, "already there. Re-running with different flags edits that entry in place; it")
		fmt.Fprintln(os.Stdout, "never appends a second block for the same name.")
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
	if fs.NArg() != 1 {
		return fmt.Errorf("remote add takes exactly one <name>\n\nRun 'muxterm remote add --help' for usage.")
	}
	name := fs.Arg(0)

	m, err := remoteManager()
	if err != nil {
		return err
	}
	action, err := m.Add(sshconfig.Entry{
		Name:         name,
		HostName:     *host,
		Port:         *port,
		User:         *user,
		IdentityFile: *identity,
	})
	reportBackup(m)
	if err != nil {
		return err
	}

	switch action {
	case sshconfig.ActionUpdated:
		fmt.Printf("updated %q in %s\n", name, m.Path())
	case sshconfig.ActionUnchanged:
		fmt.Printf("%q is already up to date in %s (nothing written)\n", name, m.Path())
	default:
		fmt.Printf("added %q to %s\n", name, m.Path())
	}
	fmt.Printf("\nCheck the entry works:  ssh %s true\n", name)
	return nil
}

func runRemoteRemove(args []string) error {
	fs := flag.NewFlagSet("remote remove", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm remote remove <name>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Delete a muxterm-managed entry from your ssh config. Only the marked block")
		fmt.Fprintln(os.Stdout, "is removed; a Host block you wrote by hand is never touched.")
	}
	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("remote remove takes exactly one <name>\n\nRun 'muxterm remote remove --help' for usage.")
	}
	name := fs.Arg(0)

	m, err := remoteManager()
	if err != nil {
		return err
	}
	_, err = m.Remove(name)
	reportBackup(m)
	if err != nil {
		return err
	}
	fmt.Printf("removed %q from %s\n", name, m.Path())
	return nil
}

func runRemoteList(args []string) error {
	fs := flag.NewFlagSet("remote list", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm remote list")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "List the entries muxterm manages, and separately the other hosts found in")
		fmt.Fprintln(os.Stdout, "the same ssh config (and its Include files). Those are reported so you can")
		fmt.Fprintln(os.Stdout, "see what is reachable — muxterm never edits them.")
	}
	if err := fs.Parse(reorderFlagsFirst(fs, args)); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}

	m, err := remoteManager()
	if err != nil {
		return err
	}
	listing, err := m.List()
	if err != nil {
		return err
	}

	fmt.Printf("ssh config: %s\n\n", listing.Path)

	fmt.Println("muxterm-managed entries:")
	if len(listing.Managed) == 0 {
		fmt.Println("  (none)  — add one with 'muxterm remote add <name> --host <h>'")
	}
	width := 0
	for _, e := range listing.Managed {
		if len(e.Name) > width {
			width = len(e.Name)
		}
	}
	for _, e := range listing.Managed {
		fmt.Printf("  %-*s  %s\n", width, e.Name, describeEntry(e))
	}

	fmt.Println("")
	fmt.Println("other hosts in this config (not managed by muxterm):")
	if len(listing.Others) == 0 {
		fmt.Println("  (none)")
	}
	for _, name := range listing.Others {
		fmt.Printf("  %s\n", name)
	}
	return nil
}

// describeEntry renders one managed entry as the ssh target it resolves to,
// e.g. "ken@10.0.0.4:2222  identity ~/.ssh/id_ed25519".
func describeEntry(e sshconfig.Entry) string {
	var b strings.Builder
	if e.User != "" {
		b.WriteString(e.User + "@")
	}
	if e.HostName == "" {
		b.WriteString("(no HostName)")
	} else {
		b.WriteString(e.HostName)
	}
	if e.Port != 0 {
		fmt.Fprintf(&b, ":%d", e.Port)
	}
	if e.IdentityFile != "" {
		b.WriteString("  identity " + e.IdentityFile)
	}
	return b.String()
}
