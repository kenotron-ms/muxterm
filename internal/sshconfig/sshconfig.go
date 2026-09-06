// Package sshconfig performs surgical edits on an OpenSSH client config.
//
// This file is the user's real credential config: it names their keys, jump
// hosts, and internal machines, and breaking it locks them out of their own
// infrastructure. So the operating rule is that EVERYTHING UNMANAGED IS
// SACRED. muxterm writes only between its own markers, splices by byte offset
// rather than re-serializing a parsed model (which would quietly reformat
// comments, blank lines, and ordering), preserves the file's trailing-newline
// state, backs the file up before its first write, and replaces it atomically
// so a crash can never leave a truncated config behind.
//
// The package is deliberately free of CLI concerns — no flags, no printing —
// so the same editing behavior is available to a future browser-side "add a
// remote" flow without going through argv.
package sshconfig

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// EnvPath names the environment variable that redirects which ssh config is
// edited. It exists so this package can be exercised against a scratch file:
// nothing that mutates a real ~/.ssh/config should ever be verified against a
// real ~/.ssh/config.
const EnvPath = "MUXTERM_SSH_CONFIG"

// Action reports what a mutation actually did, which is not always what was
// asked: `add` on an entry that already matches changes nothing.
type Action string

const (
	ActionCreated   Action = "created"
	ActionUpdated   Action = "updated"
	ActionRemoved   Action = "removed"
	ActionUnchanged Action = "unchanged"
)

// Entry is one muxterm-managed host.
//
// The field set is deliberately small. muxterm owns these blocks, so anything
// it emits it must also be prepared to overwrite; opinions beyond what is
// needed to reach the host belong in the user's own config, where muxterm will
// never touch them.
type Entry struct {
	Name         string // ssh alias, and the marker name that identifies the block
	HostName     string // required: the address ssh actually connects to
	Port         int    // 0 means "omit Port and let ssh use its default"
	User         string // optional
	IdentityFile string // optional
}

// Manager edits one ssh config file.
//
// One Manager corresponds to one command invocation: it remembers whether the
// backup for this invocation has been taken, which is what keeps a multi-write
// run from filling the directory with copies.
type Manager struct {
	path       string
	backupPath string
	backupDone bool
}

// DefaultPath returns the config file to edit: $MUXTERM_SSH_CONFIG when set,
// otherwise ~/.ssh/config.
func DefaultPath() (string, error) {
	if p := strings.TrimSpace(os.Getenv(EnvPath)); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate home directory: %w", err)
	}
	return filepath.Join(home, ".ssh", "config"), nil
}

// New returns a Manager for the config file at path.
func New(path string) *Manager { return &Manager{path: path} }

// Path is the config file this Manager edits.
func (m *Manager) Path() string { return m.path }

// BackupPath is the backup taken during this invocation, or "" if none was
// taken (nothing was written, or the file did not exist yet).
//
// It is exposed separately from any Action so a caller can report the backup
// even when the write that followed it failed — the moment the path matters
// most.
func (m *Manager) BackupPath() string { return m.backupPath }

// Listing is what List found.
type Listing struct {
	Path string
	// Managed are the entries inside muxterm markers, in file order.
	Managed []Entry
	// Others are Host aliases found in the same config (and its Includes) that
	// muxterm did not write. They are reported, never touched: they are
	// candidates the user could connect to, not entries muxterm owns.
	Others []string
}

// List reports the managed entries and the hand-written hosts alongside them.
// A missing config file is an empty listing, not an error.
func (m *Manager) List() (Listing, error) {
	out := Listing{Path: m.path}

	content, _, err := m.read()
	if err != nil {
		return Listing{}, err
	}
	// Strict here: a malformed managed region means the listing would lie
	// about what muxterm owns, and the user needs to know before they discover
	// it during a write.
	blocks, err := findBlocks(content)
	if err != nil {
		return Listing{}, fmt.Errorf("%s: %w", m.path, err)
	}
	for _, b := range blocks {
		out.Managed = append(out.Managed, parseEntry(b.name, b.text(content)))
	}

	decls, err := unmanagedHosts(m.path)
	if err != nil {
		return Listing{}, err
	}
	seen := make(map[string]bool)
	for _, d := range decls {
		if d.pattern == "" || strings.HasPrefix(d.pattern, "!") || strings.ContainsAny(d.pattern, "*?") {
			continue // a pattern matches hosts, it is not a host
		}
		if seen[d.pattern] {
			continue
		}
		seen[d.pattern] = true
		out.Others = append(out.Others, d.pattern)
	}
	return out, nil
}

// Add writes e as a managed block, updating the existing block of that name in
// place when there is one.
//
// In place is the load-bearing word: re-running `add` must converge on one
// block, and a changed port must move the port line that is already there
// rather than append a second Host that ssh would ignore (first value wins).
func (m *Manager) Add(e Entry) (Action, error) {
	if err := e.validate(); err != nil {
		return "", err
	}

	content, existed, err := m.read()
	if err != nil {
		return "", err
	}
	blocks, err := findBlocks(content)
	if err != nil {
		return "", fmt.Errorf("%s: %w\n\nmuxterm will not edit a config whose managed blocks are inconsistent; fix the markers by hand first", m.path, err)
	}

	matches := findBlock(blocks, e.Name)
	if len(matches) > 1 {
		return "", fmt.Errorf("%s: found %d muxterm blocks named %q; refusing to guess which one to update — delete the extra blocks by hand", m.path, len(matches), e.Name)
	}

	// Refuse to hijack a Host the user wrote themselves. Silently shadowing it
	// would be worse than failing: muxterm's block is read first, so ssh's
	// first-value-wins rule would override their keys and jump hosts with no
	// visible cause.
	decls, err := unmanagedHosts(m.path)
	if err != nil {
		return "", err
	}
	if d, ok := collidingHost(decls, e.Name); ok {
		return "", fmt.Errorf("%s:%d already declares Host %q and muxterm did not write it\n\nmuxterm will not take over a host you configured by hand; choose another name or remove that block yourself", d.file, d.line, d.pattern)
	}

	rendered := render(e)

	var updated string
	action := ActionCreated
	switch {
	case len(matches) == 1:
		b := matches[0]
		old := b.text(content)
		replacement := rendered
		if !strings.HasSuffix(old, "\n") {
			// The block ends the file and the file has no trailing newline.
			// Keep it that way.
			replacement = strings.TrimSuffix(rendered, "\n")
		}
		if replacement == old {
			return ActionUnchanged, nil // nothing to write, so nothing to back up
		}
		updated = content[:b.start] + replacement + content[b.end:]
		action = ActionUpdated
	case content == "":
		updated = rendered
	case strings.HasSuffix(content, "\n"):
		// The common case: append the block as-is. Nothing is inserted before
		// it, so Remove can restore the file byte-for-byte.
		updated = content + rendered
	default:
		// The file's last line has no terminator. One newline must be added or
		// the marker would be appended onto the middle of the user's line; the
		// block is then written without a trailing newline so the file's
		// "no newline at end" state is preserved.
		updated = content + "\n" + strings.TrimSuffix(rendered, "\n")
	}

	if err := m.write(content, updated, existed); err != nil {
		return "", err
	}
	return action, nil
}

// Remove deletes the managed block named name.
//
// It deletes the marker lines and everything between them, and nothing else —
// not a neighbouring blank line, not a comment the user parked above it. On a
// config whose blocks muxterm appended, this restores the file byte-for-byte.
func (m *Manager) Remove(name string) (Action, error) {
	if err := ValidateName(name); err != nil {
		return "", err
	}

	content, existed, err := m.read()
	if err != nil {
		return "", err
	}
	if !existed {
		return "", fmt.Errorf("%s does not exist, so there is nothing named %q to remove", m.path, name)
	}
	blocks, err := findBlocks(content)
	if err != nil {
		return "", fmt.Errorf("%s: %w\n\nmuxterm will not edit a config whose managed blocks are inconsistent; fix the markers by hand first", m.path, err)
	}

	matches := findBlock(blocks, name)
	if len(matches) == 0 {
		return "", fmt.Errorf("%s has no muxterm-managed entry named %q (hand-written Host blocks are never removed by muxterm)", m.path, name)
	}

	// Back to front, so each splice leaves the earlier offsets valid.
	updated := content
	for i := len(matches) - 1; i >= 0; i-- {
		b := matches[i]
		start := b.start
		// Undo Add's separator. When the file had no terminator on its last
		// line, Add wrote "\n" + block-without-trailing-newline so the marker
		// could not land mid-line and the file's "no newline at end" state
		// survived. b.start sits after that newline, so splicing from it would
		// leave the separator behind and the file would gain one byte on every
		// add/remove cycle. Both halves of Add's invariant have to hold before
		// reclaiming it: the block ends the file, and it has no trailing
		// newline of its own.
		if b.end == len(updated) && start > 0 && updated[start-1] == '\n' &&
			!strings.HasSuffix(updated[start:b.end], "\n") {
			start--
		}
		updated = updated[:start] + updated[b.end:]
	}

	if err := m.write(content, updated, existed); err != nil {
		return "", err
	}
	return ActionRemoved, nil
}

// read returns the config's current contents and whether it exists. A missing
// file is not an error: `remote add` on a machine with no ssh config yet is a
// perfectly ordinary first run.
func (m *Manager) read() (content string, existed bool, err error) {
	data, err := os.ReadFile(m.path) //nolint:gosec // the user's own ssh config
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("read %s: %w", m.path, err)
	}
	return string(data), true, nil
}

// write backs up the original (once per invocation) and then atomically
// replaces the file. The backup comes first so the undo path exists before
// anything can go wrong.
func (m *Manager) write(original, updated string, existed bool) error {
	if err := m.ensureBackup(original, existed); err != nil {
		return err
	}
	return atomicWrite(m.path, updated)
}

// render turns an Entry into the exact bytes of a managed block, always ending
// with a newline (callers strip it to preserve a file that ends without one).
//
// StrictHostKeyChecking accept-new is the single opinion muxterm adds: it
// matches the convention already in the user's config and is what makes a
// first connection to a freshly provisioned host work without an interactive
// prompt, while still refusing a host whose key later CHANGES. Nothing else is
// emitted — every extra line is one more thing muxterm would silently
// overwrite on the next `add`.
func render(e Entry) string {
	var b strings.Builder
	b.WriteString(beginPrefix + e.Name + beginSuffix + "\n")
	b.WriteString("Host " + e.Name + "\n")
	b.WriteString("    HostName " + quoteValue(e.HostName) + "\n")
	if e.Port != 0 {
		fmt.Fprintf(&b, "    Port %d\n", e.Port)
	}
	if e.User != "" {
		b.WriteString("    User " + quoteValue(e.User) + "\n")
	}
	if e.IdentityFile != "" {
		b.WriteString("    IdentityFile " + quoteValue(e.IdentityFile) + "\n")
	}
	b.WriteString("    StrictHostKeyChecking accept-new\n")
	b.WriteString(endPrefix + e.Name + endSuffix + "\n")
	return b.String()
}

// quoteValue wraps a value containing spaces in ssh's double quotes. Values are
// validated first, so nothing that reaches here can contain a quote of its own.
func quoteValue(v string) string {
	if strings.ContainsAny(v, " \t") {
		return `"` + v + `"`
	}
	return v
}

// validate checks an Entry before any of it is rendered into the config.
func (e Entry) validate() error {
	if err := ValidateName(e.Name); err != nil {
		return err
	}
	if strings.TrimSpace(e.HostName) == "" {
		return fmt.Errorf("--host is required: a remote entry with no HostName cannot connect to anything")
	}
	if err := validateValue("--host", e.HostName, false); err != nil {
		return err
	}
	if err := validateValue("--user", e.User, false); err != nil {
		return err
	}
	// A key path may legitimately contain a space, and ssh has quoting for it.
	if err := validateValue("--identity", e.IdentityFile, true); err != nil {
		return err
	}
	if e.Port != 0 && (e.Port < 1 || e.Port > 65535) {
		return fmt.Errorf("--port %d is out of range: a TCP port is 1-65535", e.Port)
	}
	return nil
}

// ValidateName rejects anything that could not be a plain ssh alias.
//
// This is a security boundary, not tidiness. The name is written into the
// config verbatim, on its own line and inside the markers, so a name
// containing a newline would let the caller append arbitrary ssh directives —
// a ProxyCommand runs a shell command on every single connection to that host.
// An allowlist is used rather than a blocklist because a blocklist has to be
// right about every dangerous character, and this one only has to be right
// about the safe ones.
func ValidateName(name string) error {
	const allowed = "._-@"
	if name == "" {
		return fmt.Errorf("remote name is required")
	}
	if len(name) > 128 {
		return fmt.Errorf("remote name is too long (%d characters; the limit is 128)", len(name))
	}
	for i, r := range name {
		if !isAlphanumeric(r) && !strings.ContainsRune(allowed, r) {
			return fmt.Errorf("invalid remote name %q: character %q at position %d is not allowed\n\nA name may contain only letters, digits, and %q. Whitespace, '#', and newlines are refused because the name is written into your ssh config verbatim, where they could inject arbitrary directives (a ProxyCommand, for instance, runs a shell command on every connection)", name, string(r), i+1, allowed)
		}
	}
	if first := rune(name[0]); !isAlphanumeric(first) {
		return fmt.Errorf("invalid remote name %q: it must start with a letter or digit", name)
	}
	return nil
}

// validateValue rejects option values that could break out of the line they
// are written on. Control characters (a newline above all) and '#' would end
// or comment the line; a double quote or backslash would confuse ssh's own
// tokenizer.
func validateValue(flagName, v string, allowSpace bool) error {
	if v == "" {
		return nil
	}
	for _, r := range v {
		switch {
		case r == '\n' || r == '\r' || unicode.IsControl(r):
			return fmt.Errorf("invalid %s value %q: control characters are not allowed (they could inject additional ssh directives)", flagName, v)
		case r == '#' || r == '"' || r == '\\':
			return fmt.Errorf("invalid %s value %q: the characters '#', '\"', and '\\' are not allowed in an ssh config value", flagName, v)
		case !allowSpace && (r == ' ' || r == '\t'):
			return fmt.Errorf("invalid %s value %q: whitespace is not allowed", flagName, v)
		}
	}
	return nil
}

func isAlphanumeric(r rune) bool {
	return ('a' <= r && r <= 'z') || ('A' <= r && r <= 'Z') || ('0' <= r && r <= '9')
}
