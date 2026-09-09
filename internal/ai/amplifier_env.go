// internal/ai/amplifier_env.go
package ai

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// AmplifierHomeEnv is the variable amplifier resolves its home directory from,
// ahead of ~/.amplifier.
//
// It is honoured here for one reason: to report the truth. amplifier reads its
// keys from $AMPLIFIER_HOME/keys.env when this is set
// (amplifier_foundation/paths/resolution.py, get_amplifier_home), so a muxterm
// that looked only at ~/.amplifier on such a machine would inspect a file
// nothing reads and then state its findings confidently. Detection that is
// confidently wrong is worse than detection that is absent -- it is the same
// failure as calling a stale key "configured".
const AmplifierHomeEnv = "AMPLIFIER_HOME"

// AmplifierHome returns the directory amplifier keeps its own state in,
// resolved the way amplifier resolves it: $AMPLIFIER_HOME first, then
// ~/.amplifier. Empty when neither can be determined.
func AmplifierHome() string {
	if v := strings.TrimSpace(os.Getenv(AmplifierHomeEnv)); v != "" {
		if abs, err := filepath.Abs(expandTilde(v)); err == nil {
			return abs
		}
		return expandTilde(v)
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = os.Getenv("HOME")
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".amplifier")
}

// expandTilde resolves a leading ~ the way a shell would, because
// $AMPLIFIER_HOME is set by hand often enough to arrive as "~/somewhere".
// amplifier itself calls Path.expanduser() on it.
func expandTilde(p string) string {
	if p != "~" && !strings.HasPrefix(p, "~/") {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = os.Getenv("HOME")
	}
	if home == "" {
		return p
	}
	if p == "~" {
		return home
	}
	return filepath.Join(home, p[2:])
}

// AmplifierHomeExists reports whether amplifier's home directory is there.
//
// Reported separately from the keys file because they are different answers to
// different questions. No directory at all means amplifier is very likely not
// installed on this machine, and the honest response is to SAY SO rather than
// to conjure a config tree for a tool that is not there. A directory with no
// keys.env in it means amplifier is installed and simply has no keys yet.
func AmplifierHomeExists() bool {
	dir := AmplifierHome()
	if dir == "" {
		return false
	}
	st, err := os.Stat(dir)
	return err == nil && st.IsDir()
}

// AmplifierKeysPath returns <amplifier home>/keys.env -- the file the amplifier
// CLI keeps its own provider secrets in.
//
// READ ONLY, AND THAT IS A DESIGN DECISION, NOT AN OVERSIGHT. This file
// belongs to a different tool. It is hand-editable, users back it up, and
// amplifier rewrites it with its own atomic writer and header block. muxterm
// reads it so it can tell the truth about what this machine already has; it
// never writes it, never renames it, never rewrites it. Everything muxterm
// stores goes in ConfigDir() instead.
func AmplifierKeysPath() string {
	dir := AmplifierHome()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "keys.env")
}

// amplifierKeys parses ~/.amplifier/keys.env into a name->value map.
//
// The format amplifier writes is one KEY="value" per line, with # comments;
// `export KEY=value` and unquoted values are accepted too, because the file
// is hand-edited often enough that being strict here would mean reporting
// "not configured" for a machine that is, in fact, configured.
//
// A missing file is the normal case on a fresh machine and is not an error.
// An unreadable one is also not an error: detection degrades to "muxterm
// cannot see this file", never to a failed request.
func amplifierKeys() map[string]string {
	out := map[string]string{}
	path := AmplifierKeysPath()
	if path == "" {
		return out
	}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close() //nolint:errcheck

	sc := bufio.NewScanner(f)
	// A key is a few hundred bytes; a megabyte line is not a credential and
	// is not worth buffering.
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		name, value, ok := parseEnvLine(sc.Text())
		if ok {
			out[name] = value
		}
	}
	return out
}

// parseEnvLine splits one line of a dotenv-style file into a name and value.
// It reports ok=false for blanks, comments, and anything that is not an
// assignment.
func parseEnvLine(line string) (name, value string, ok bool) {
	s := strings.TrimSpace(line)
	if s == "" || strings.HasPrefix(s, "#") {
		return "", "", false
	}
	s = strings.TrimPrefix(s, "export ")
	eq := strings.IndexByte(s, '=')
	if eq <= 0 {
		return "", "", false
	}
	name = strings.TrimSpace(s[:eq])
	value = strings.TrimSpace(s[eq+1:])
	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') ||
			(value[0] == '\'' && value[len(value)-1] == '\'') {
			value = value[1 : len(value)-1]
		}
	}
	if name == "" {
		return "", "", false
	}
	return name, value, true
}
