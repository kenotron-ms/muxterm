package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// WriteVoiceSection replaces the [voice] table in the TOML file at path,
// leaving every other byte of that file exactly as it was.
//
// WHY NOT config.Write. Write re-encodes the whole Config struct, so it
// rewrites the entire file from a struct that has no idea comments ever
// existed. Every comment, every blank line, every hand-authored key muxterm
// does not model is gone the moment a font size changes. That is the current
// cost of PATCH /api/config and it is not one worth extending to the section
// an operator is most likely to have annotated -- the one with the endpoint
// URL and the auth mode in it. So this is a text splice, not a re-encode.
//
// What survives, exactly:
//
//   - Every other section, byte for byte, including its comments, its
//     ordering, its indentation and its blank lines.
//   - Any comment ABOVE the [voice] header (it is not part of the section).
//   - The file's existing permission mode.
//
// What does not survive:
//
//   - Comments and unrecognised keys INSIDE [voice]. The section is replaced
//     wholesale, because a key-by-key merge would have to decide what to do
//     with a commented-out setting the UI is now setting for real, and
//     guessing there is how a config file ends up saying two things at once.
//     This is stated in the UI next to the save button, not just here.
//
// A file with no [voice] section gets one appended. A file that does not
// exist at all is created with just this section, at 0644 -- the same mode
// config.Write pins, and safe because NO SECRET IS EVER WRITTEN HERE. The key
// itself lives in internal/secretfile at 0600; this section only ever records
// that one is stored.
func WriteVoiceSection(path string, v VoiceConfig) error {
	raw, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		dir := filepath.Dir(path)
		if mkErr := os.MkdirAll(dir, 0o755); mkErr != nil {
			return fmt.Errorf("config: mkdir %s: %w", dir, mkErr)
		}
		return writeFilePreservingMode(path, renderVoiceSection(v), 0o644)
	case err != nil:
		return fmt.Errorf("config: read %s: %w", path, err)
	}

	body := string(raw)
	if err := refuseDottedVoiceKeys(body); err != nil {
		return err
	}

	start, end, found := findVoiceSection(body)
	block := renderVoiceSection(v)

	var out string
	if found {
		out = body[:start] + block + body[end:]
	} else {
		// Append. A file that does not end in a newline would otherwise
		// glue its last key onto the [voice] header.
		sep := ""
		if body != "" && !strings.HasSuffix(body, "\n") {
			sep = "\n"
		}
		if body != "" {
			sep += "\n"
		}
		out = body + sep + block
	}

	mode := os.FileMode(0o644)
	if info, statErr := os.Stat(path); statErr == nil {
		mode = info.Mode().Perm()
	}
	return writeFilePreservingMode(path, out, mode)
}

// writeFilePreservingMode does the same atomic temp-write-then-rename dance
// as config.Write, pinning mode explicitly because os.CreateTemp makes 0600
// and a config file that silently became owner-only would be a surprising
// side effect of saving a setting.
func writeFilePreservingMode(path, content string, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".config.toml.*")
	if err != nil {
		return fmt.Errorf("config: create temp in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) //nolint:errcheck // no-op once the rename succeeds

	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close() //nolint:errcheck
		return fmt.Errorf("config: write %s: %w", tmpName, err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close() //nolint:errcheck
		return fmt.Errorf("config: sync %s: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("config: close %s: %w", tmpName, err)
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return fmt.Errorf("config: chmod %s: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("config: rename %s: %w", tmpName, err)
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close() //nolint:errcheck
	}
	return nil
}

// findVoiceSection locates the [voice] table's byte span: from the start of
// its header line to the start of the next top-level table header, or EOF.
//
// Line-based on purpose. A full TOML parse would give a syntax tree with no
// comments in it, which is precisely the information this function exists to
// preserve.
func findVoiceSection(body string) (start, end int, found bool) {
	lines := splitLinesKeepingEnds(body)
	offset := 0
	// blankRun is how many bytes of trailing blank lines immediately precede
	// the current position. They sit inside the section's span but belong to
	// the READER, not to the section: swallowing them would weld the next
	// header onto the last key every time a setting is saved.
	blankRun := 0
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !found {
			if isVoiceHeader(trimmed) {
				start, found = offset, true
			}
		} else if isTableHeader(trimmed) {
			return start, offset - blankRun, true
		}
		if trimmed == "" {
			blankRun += len(line)
		} else {
			blankRun = 0
		}
		offset += len(line)
	}
	if found {
		return start, len(body) - blankRun, true
	}
	return 0, 0, false
}

func splitLinesKeepingEnds(s string) []string {
	var out []string
	for len(s) > 0 {
		i := strings.IndexByte(s, '\n')
		if i < 0 {
			out = append(out, s)
			break
		}
		out = append(out, s[:i+1])
		s = s[i+1:]
	}
	return out
}

// isTableHeader reports whether a trimmed line opens a new table or
// array-of-tables. A comment that happens to start with '[' is not one.
func isTableHeader(trimmed string) bool {
	return strings.HasPrefix(trimmed, "[")
}

// isVoiceHeader matches the table header forms TOML actually permits for this
// section: [voice], with optional surrounding whitespace, and the quoted
// spelling ["voice"]. It deliberately does NOT match [voice.something], which
// is a different (sub)table.
func isVoiceHeader(trimmed string) bool {
	if !strings.HasPrefix(trimmed, "[") || !strings.HasSuffix(trimmed, "]") {
		return false
	}
	if strings.HasPrefix(trimmed, "[[") {
		return false
	}
	inner := strings.TrimSpace(trimmed[1 : len(trimmed)-1])
	inner = strings.Trim(inner, `"'`)
	return strings.TrimSpace(inner) == "voice"
}

// refuseDottedVoiceKeys stops a splice that would produce a file saying two
// different things.
//
// TOML allows `voice.enabled = true` at the top level, which defines the same
// table this function's caller is about to append a [voice] header for --
// yielding a duplicate-key error on the next load. Rather than rewrite a form
// muxterm has never written, refuse and say so: the operator who authored it
// by hand can resolve it by hand.
func refuseDottedVoiceKeys(body string) error {
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if isTableHeader(trimmed) {
			// Past the top level; dotted keys below belong to
			// whatever table is in scope, not to [voice].
			return nil
		}
		if strings.HasPrefix(trimmed, "voice.") || strings.HasPrefix(trimmed, `"voice".`) {
			return fmt.Errorf("config: this file configures voice with a top-level dotted key (%q); settings cannot edit that form safely -- rewrite it as a [voice] section and try again", trimmed)
		}
	}
	return nil
}

// renderVoiceSection writes the section in the same shape BurntSushi/toml
// produces for this file today: a bare header, two-space indented keys,
// durations as quoted Go duration strings. Matching it means a file that has
// only ever been machine-written looks unchanged apart from the values.
//
// Optional keys are omitted when empty, mirroring the `omitempty` tags on
// VoiceConfig, so a section written here round-trips through Load and Write
// without gaining noise.
func renderVoiceSection(v VoiceConfig) string {
	var b strings.Builder
	b.WriteString("[voice]\n")
	fmt.Fprintf(&b, "  enabled = %t\n", v.Enabled)
	if v.Endpoint != "" {
		fmt.Fprintf(&b, "  endpoint = %s\n", strconv.Quote(v.Endpoint))
	}
	if v.Model != "" {
		fmt.Fprintf(&b, "  model = %s\n", strconv.Quote(v.Model))
	}
	if v.AuthMode != "" {
		fmt.Fprintf(&b, "  auth_mode = %s\n", strconv.Quote(v.AuthMode))
	}
	if v.EntraScope != "" {
		fmt.Fprintf(&b, "  entra_scope = %s\n", strconv.Quote(v.EntraScope))
	}
	if v.APIKeyEnv != "" {
		fmt.Fprintf(&b, "  api_key_env = %s\n", strconv.Quote(v.APIKeyEnv))
	}
	if v.APIKeyStored {
		b.WriteString("  api_key_stored = true\n")
	}
	if v.Voice != "" {
		fmt.Fprintf(&b, "  voice = %s\n", strconv.Quote(v.Voice))
	}
	if v.SyncToolTimeout > 0 {
		fmt.Fprintf(&b, "  sync_tool_timeout = %s\n", strconv.Quote(v.SyncToolTimeout.String()))
	}
	return b.String()
}
