// internal/ai/amplifier_write.go
package ai

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// WRITING amplifier's keys.env, SURGICALLY.
//
// muxterm's DEFAULT is still not to touch this file: a credential saved in the
// browser is injected into the environment of what muxterm starts
// (internal/sessiond/lane_env.go), which repairs a stale entry without editing
// the file holding it. That default is unchanged by this file.
//
// This is the explicit action for the other case -- someone who wants
// amplifier itself fixed on this machine, so that `amplifier` typed at a plain
// shell prompt works too, not only the sessions muxterm launches. It happens
// when a user asks for it and at no other time.
//
// IT IS STRICTER THAN AMPLIFIER'S OWN WRITER, DELIBERATELY. amplifier's
// KeyManager.save_key reads the file into a dict and rewrites it whole behind a
// fixed three-line header (amplifier_app_cli/key_manager.py) -- every comment
// the user wrote, every blank line, every bit of ordering is discarded. That is
// fine for a file amplifier considers its own. It is not fine for a second tool
// reaching into it. So this writer touches ONE line and leaves every other byte
// exactly as it found it, which is a promise the owning tool does not make.
//
// The five rules it keeps, each enforced below rather than documented and
// hoped for:
//
//  1. SURGICAL. Only the managed variable's line changes. Comments, blank
//     lines, ordering, quoting style, `export ` prefixes and unrelated
//     variables all survive byte-for-byte.
//  2. A TIMESTAMPED BACKUP FIRST, named keys.env.bak-YYYYMMDDHHMMSS to match
//     the convention already on the user's disk, written before the original
//     is touched and carrying the original's mode.
//  3. MODE PRESERVED. Whatever the file was, it still is. A new file is 0600.
//  4. THE VALUE IS NEVER READABLE BACK. Nothing here returns, logs or reports
//     it; WriteResult carries paths and counts only.
//  5. AN ABSENT amplifier HOME IS REPORTED, NOT CREATED. A missing directory
//     means amplifier is probably not installed, and conjuring a config tree
//     for a tool that is not there would turn an honest "not installed" into a
//     misleading "configured".
//
// The write itself is atomic: a temp file in the same directory, fsynced, then
// renamed over the original, so no reader and no crash observes a half-written
// keys.env.

// ErrAmplifierHomeAbsent is returned when amplifier's home directory does not
// exist. It is a refusal, not a failure to be retried: see rule 5.
var ErrAmplifierHomeAbsent = errors.New("amplifier home directory does not exist")

// WriteResult describes what a write did, in terms a UI can show and a log can
// carry. Every field is a path, a count or a mode. None of them is, or is
// derived from, the credential.
type WriteResult struct {
	// Path is the file written.
	Path string `json:"path"`
	// BackupPath is the timestamped copy taken first, empty when the file did
	// not exist and there was nothing to back up.
	BackupPath string `json:"backupPath,omitempty"`
	// Created is true when keys.env did not exist and was created.
	Created bool `json:"created"`
	// Replaced is true when an existing assignment was updated in place;
	// false means the assignment was appended.
	Replaced bool `json:"replaced"`
	// LinesChanged is how many lines differ from the original. The whole point
	// of this writer is that it is 1 for a replacement, and it is asserted
	// below rather than trusted.
	LinesChanged int `json:"linesChanged"`
	// LinesTotal is the resulting line count.
	LinesTotal int `json:"linesTotal"`
	// Mode is the file's permission bits after the write.
	Mode string `json:"mode"`
	// ModePreserved is true when the file already existed and came out with
	// the mode it went in with.
	ModePreserved bool `json:"modePreserved"`
}

// WriteAmplifierKey sets one managed variable in amplifier's keys.env, leaving
// every other byte of the file alone.
//
// The value is written and then forgotten; it is never returned, and the error
// paths quote paths rather than contents.
func (m *Manager) WriteAmplifierKey(p Provider, value string) (WriteResult, error) {
	spec, ok := providerSpecs[p]
	if !ok {
		return WriteResult{}, fmt.Errorf("unknown provider %q", p)
	}
	if strings.TrimSpace(value) == "" {
		return WriteResult{}, errors.New("refusing to write an empty value")
	}

	home := AmplifierHome()
	if home == "" {
		return WriteResult{}, ErrAmplifierHomeAbsent
	}
	// Rule 5. Checked before anything is opened or created, so a refusal
	// leaves the filesystem exactly as it was.
	if st, err := os.Stat(home); err != nil || !st.IsDir() {
		return WriteResult{}, fmt.Errorf("%w: %s", ErrAmplifierHomeAbsent, home)
	}

	path := filepath.Join(home, "keys.env")
	original, statMode, existed, err := readKeysFile(path)
	if err != nil {
		return WriteResult{}, err
	}

	updated, replaced := setEnvAssignment(original, spec.KeyEnv, value)
	if bytes.Equal(updated, original) {
		// The file already says exactly this. Writing would still be correct,
		// but taking a backup and replacing a file to change nothing is noise
		// on someone else's disk.
		res := WriteResult{
			Path: path, Replaced: true, LinesChanged: 0,
			LinesTotal: countLines(original), Mode: fmt.Sprintf("%04o", statMode.Perm()),
			ModePreserved: true,
		}
		return res, nil
	}

	res := WriteResult{Path: path, Created: !existed, Replaced: replaced}

	// Rule 2. Before the original is touched, and carrying its mode so the
	// backup is no more readable than the file it copies.
	if existed {
		backup := path + ".bak-" + time.Now().Format("20060102150405")
		if err := os.WriteFile(backup, original, statMode.Perm()); err != nil {
			return WriteResult{}, fmt.Errorf("backup %s: %w", backup, err)
		}
		res.BackupPath = backup
	}

	mode := statMode.Perm()
	if !existed {
		mode = 0o600
	}
	if err := atomicWrite(path, updated, mode); err != nil {
		return WriteResult{}, err
	}

	// Rule 3, verified rather than assumed -- a umask or a filesystem can
	// disagree with what was asked for.
	after, err := os.Stat(path)
	if err != nil {
		return WriteResult{}, err
	}
	res.Mode = fmt.Sprintf("%04o", after.Mode().Perm())
	res.ModePreserved = !existed || after.Mode().Perm() == statMode.Perm()

	// Rule 1, measured. A caller can assert on this instead of taking the
	// comment at the top of this file on trust.
	res.LinesChanged = countChangedLines(original, updated)
	res.LinesTotal = countLines(updated)
	return res, nil
}

// readKeysFile returns the file's bytes and mode. A missing file is not an
// error: it is the normal case on a machine amplifier has never saved a key
// on, and it is reported through the `existed` return.
func readKeysFile(path string) (data []byte, mode os.FileMode, existed bool, err error) {
	st, statErr := os.Stat(path)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return nil, 0o600, false, nil
		}
		return nil, 0, false, statErr
	}
	b, readErr := os.ReadFile(path)
	if readErr != nil {
		return nil, 0, false, readErr
	}
	return b, st.Mode(), true, nil
}

// setEnvAssignment replaces the value of `name` in a dotenv-style file,
// touching nothing else, and reports whether it replaced or appended.
//
// It works on RAW LINES rather than a parsed map, because a map cannot put
// back what it did not keep: comments, blank lines, ordering, alignment and
// quoting style all live only in the original bytes. Everything except the one
// matched line is copied through untouched, including its line ending.
//
// The quoting style of the line being replaced is preserved: a bare assignment
// stays bare, a double-quoted one stays double-quoted, and an `export ` prefix
// survives. That matters because this file is hand-edited, and a writer that
// "normalises" someone's file is a writer they stop trusting.
func setEnvAssignment(original []byte, name, value string) (updated []byte, replaced bool) {
	lines := splitKeepEnds(original)
	for i, line := range lines {
		body, ending := splitEnding(line)
		got, ok := assignmentName(body)
		if !ok || got != name {
			continue
		}
		prefix := ""
		trimmed := strings.TrimLeft(body, " \t")
		lead := body[:len(body)-len(trimmed)]
		if strings.HasPrefix(trimmed, "export ") {
			prefix = "export "
			trimmed = strings.TrimPrefix(trimmed, "export ")
		}
		eq := strings.IndexByte(trimmed, '=')
		old := strings.TrimSpace(trimmed[eq+1:])
		quote := ""
		if len(old) >= 2 && (old[0] == '"' || old[0] == '\'') && old[len(old)-1] == old[0] {
			quote = string(old[0])
		}
		lines[i] = lead + prefix + name + "=" + quote + value + quote + ending
		return bytes.Join(lines2bytes(lines), nil), true
	}

	// Not present: append. A file that does not end in a newline gets one
	// first, so the appended assignment is a line rather than a suffix of
	// whatever the last line was.
	out := append([]byte(nil), original...)
	if len(out) > 0 && out[len(out)-1] != '\n' {
		out = append(out, '\n')
	}
	out = append(out, []byte(name+"=\""+value+"\"\n")...)
	return out, false
}

// assignmentName extracts the variable a line assigns, or reports false for
// blanks, comments and anything that is not an assignment.
func assignmentName(body string) (string, bool) {
	s := strings.TrimSpace(body)
	if s == "" || strings.HasPrefix(s, "#") {
		return "", false
	}
	s = strings.TrimPrefix(s, "export ")
	eq := strings.IndexByte(s, '=')
	if eq <= 0 {
		return "", false
	}
	name := strings.TrimSpace(s[:eq])
	if name == "" {
		return "", false
	}
	return name, true
}

func splitKeepEnds(b []byte) []string {
	if len(b) == 0 {
		return nil
	}
	var out []string
	start := 0
	for i := 0; i < len(b); i++ {
		if b[i] == '\n' {
			out = append(out, string(b[start:i+1]))
			start = i + 1
		}
	}
	if start < len(b) {
		out = append(out, string(b[start:]))
	}
	return out
}

func splitEnding(line string) (body, ending string) {
	switch {
	case strings.HasSuffix(line, "\r\n"):
		return line[:len(line)-2], "\r\n"
	case strings.HasSuffix(line, "\n"):
		return line[:len(line)-1], "\n"
	default:
		return line, ""
	}
}

func lines2bytes(lines []string) [][]byte {
	out := make([][]byte, len(lines))
	for i, l := range lines {
		out[i] = []byte(l)
	}
	return out
}

func countLines(b []byte) int { return len(splitKeepEnds(b)) }

// countChangedLines counts lines that differ positionally. With a surgical
// replacement this is 1; with an append it is 1 plus whatever a missing final
// newline forced.
func countChangedLines(a, b []byte) int {
	la, lb := splitKeepEnds(a), splitKeepEnds(b)
	n := 0
	for i := 0; i < len(la) || i < len(lb); i++ {
		var x, y string
		if i < len(la) {
			x = la[i]
		}
		if i < len(lb) {
			y = lb[i]
		}
		if x != y {
			n++
		}
	}
	return n
}

// atomicWrite replaces path with data: a temp file in the SAME directory (so
// the rename cannot cross a filesystem), fsynced before it is renamed, and
// removed if anything fails. No reader ever sees a partial file.
func atomicWrite(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".keys.env.tmp-")
	if err != nil {
		return fmt.Errorf("create temp in %s: %w", dir, err)
	}
	tmp := f.Name()
	defer os.Remove(tmp) //nolint:errcheck // best effort; a successful rename makes this a no-op

	if _, err := f.Write(data); err != nil {
		f.Close() //nolint:errcheck
		return fmt.Errorf("write temp: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close() //nolint:errcheck
		return fmt.Errorf("sync temp: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}
	// Chmod BEFORE the rename, so the file is never briefly world-readable at
	// its real name.
	if err := os.Chmod(tmp, mode); err != nil {
		return fmt.Errorf("chmod temp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("rename onto %s: %w", path, err)
	}
	return nil
}
