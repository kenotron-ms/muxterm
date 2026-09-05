package sshconfig

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Marker syntax for a muxterm-managed block.
//
// Each managed host gets its OWN begin/end pair rather than one big
// muxterm-owned region, so a block can be rewritten or deleted without
// disturbing its neighbours, and so a hand edit to one entry cannot cascade
// into the others.
//
// The markers are deliberately distinctive (and are comments, so ssh ignores
// them). They are the only thing that makes a block ours: if a marker pair is
// missing, the entry is treated as the user's hand-written config and is never
// touched.
const (
	beginPrefix = "# >>> muxterm remote: "
	beginSuffix = " >>>"
	endPrefix   = "# <<< muxterm remote: "
	endSuffix   = " <<<"
)

// maxIncludeDepth matches OpenSSH's own limit on nested Include directives and
// is the backstop that stops a cycle of files including each other.
const maxIncludeDepth = 16

// span is a half-open byte range [start, end) inside a file's contents.
type span struct{ start, end int }

// block is one marker-delimited managed region, located by BYTE OFFSETS rather
// than by line index.
//
// Offsets are the whole point: every edit this package makes is a splice of
// content[:b.start] + new + content[b.end:], which is what guarantees that
// nothing outside the markers can change. Re-serializing a parsed model would
// silently reformat the user's comments, blank lines, and ordering; this is
// their real credential config, so it is never re-serialized.
type block struct {
	name  string // the name in the marker, not the Host line
	start int    // first byte of the begin-marker line
	end   int    // one past the last byte of the end-marker line, newline included
	line  int    // 1-based line number of the begin marker, for error messages
}

// text returns the block's raw bytes out of the content it was located in.
func (b block) text(content string) string { return content[b.start:b.end] }

// lineSpans returns the byte range of every line in content, each INCLUDING
// its trailing newline when it has one. A final line with no newline yields a
// span with no terminator, which is how the file's trailing-newline state
// survives a round trip through this package.
func lineSpans(content string) []span {
	var out []span
	start := 0
	for i := 0; i < len(content); i++ {
		if content[i] == '\n' {
			out = append(out, span{start, i + 1})
			start = i + 1
		}
	}
	if start < len(content) {
		out = append(out, span{start, len(content)})
	}
	return out
}

// findBlocks locates every managed block in content, in file order.
//
// On a malformed managed region (an unterminated begin marker, an end marker
// with no begin, a mismatched pair) it returns a non-nil error ALONG WITH the
// blocks it had already located. Writers must treat the error as fatal — the
// file is in a state muxterm did not create and cannot safely splice — while
// read-only callers can use the partial result to know which lines are already
// spoken for.
func findBlocks(content string) ([]block, error) {
	var (
		blocks []block
		open   *block
	)
	for i, sp := range lineSpans(content) {
		line := strings.TrimSpace(content[sp.start:sp.end])
		if name, ok := markerName(line, beginPrefix, beginSuffix); ok {
			if open != nil {
				return blocks, fmt.Errorf("line %d: muxterm block %q begins inside unterminated block %q (begun at line %d)", i+1, name, open.name, open.line)
			}
			open = &block{name: name, start: sp.start, line: i + 1}
			continue
		}
		if name, ok := markerName(line, endPrefix, endSuffix); ok {
			if open == nil {
				return blocks, fmt.Errorf("line %d: end marker for muxterm block %q with no matching begin marker", i+1, name)
			}
			if !strings.EqualFold(name, open.name) {
				return blocks, fmt.Errorf("line %d: end marker for muxterm block %q closes block %q (begun at line %d)", i+1, name, open.name, open.line)
			}
			open.end = sp.end
			blocks = append(blocks, *open)
			open = nil
		}
	}
	if open != nil {
		return blocks, fmt.Errorf("unterminated muxterm block %q begun at line %d", open.name, open.line)
	}
	return blocks, nil
}

// markerName extracts the entry name from a marker line, reporting false for
// any other line. A marker with an empty name is not a marker: it is just a
// comment, and treating it as a block boundary would let a stray line hijack
// the surgery.
func markerName(line, prefix, suffix string) (string, bool) {
	if !strings.HasPrefix(line, prefix) || !strings.HasSuffix(line, suffix) {
		return "", false
	}
	name := strings.TrimSpace(line[len(prefix) : len(line)-len(suffix)])
	if name == "" {
		return "", false
	}
	return name, true
}

// findBlock returns the managed blocks whose marker name matches name.
//
// The comparison is case-insensitive because OpenSSH's own host matching is:
// `Host Foo` and `ssh foo` are the same host to ssh, so treating them as two
// different entries here would produce two blocks competing for one alias.
func findBlock(blocks []block, name string) []block {
	var out []block
	for _, b := range blocks {
		if strings.EqualFold(b.name, name) {
			out = append(out, b)
		}
	}
	return out
}

// insideBlock reports whether the byte at off falls within a managed block.
func insideBlock(blocks []block, off int) bool {
	for _, b := range blocks {
		if off >= b.start && off < b.end {
			return true
		}
	}
	return false
}

// hostDecl is one Host pattern declared OUTSIDE every managed block, i.e. one
// the user (or another tool) wrote by hand.
type hostDecl struct {
	pattern string
	file    string
	line    int
}

// unmanagedHosts returns every hand-written Host pattern reachable from path,
// following Include directives.
//
// Includes are followed because a hijack does not need to be in the same file:
// if the user declares `Host boxb` in an Include'd file and muxterm writes its
// own `Host boxb` into the main config, muxterm's block is read first and ssh's
// first-value-wins rule silently overrides the user's settings. Refusing that
// requires seeing the included files.
//
// A relative Include resolves against the DIRECTORY OF THE CONFIG BEING READ
// (which is ~/.ssh for the default path, matching OpenSSH), so a redirected
// config file stays self-consistent instead of reaching back into the real
// ~/.ssh.
func unmanagedHosts(path string) ([]hostDecl, error) {
	return scanHosts(path, filepath.Dir(path), 0, map[string]bool{})
}

func scanHosts(path, baseDir string, depth int, seenFiles map[string]bool) ([]hostDecl, error) {
	if depth > maxIncludeDepth {
		return nil, fmt.Errorf("ssh config %s: Include nested deeper than %d levels", path, maxIncludeDepth)
	}
	if seenFiles[path] {
		return nil, nil // already visited: an Include cycle contributes nothing
	}
	seenFiles[path] = true

	data, err := os.ReadFile(path) //nolint:gosec // path is the user's own ssh config
	if err != nil {
		if os.IsNotExist(err) {
			// An Include naming a file that does not exist is legal in ssh and
			// simply contributes nothing; a missing top-level config means
			// there is nothing to collide with yet.
			return nil, nil
		}
		return nil, fmt.Errorf("read ssh config %s: %w", path, err)
	}
	content := string(data)

	// Deliberately lenient about the error: a malformed managed region matters
	// when WRITING (Add/Remove refuse), but for a read-only scan the blocks
	// found so far are enough to know which Host lines are already ours.
	blocks, _ := findBlocks(content)

	var out []hostDecl
	for i, sp := range lineSpans(content) {
		if insideBlock(blocks, sp.start) {
			continue
		}
		keyword, rest, ok := splitKeyword(content[sp.start:sp.end])
		if !ok {
			continue
		}
		switch strings.ToLower(keyword) {
		case "host":
			for _, pattern := range tokenize(rest) {
				out = append(out, hostDecl{pattern: pattern, file: path, line: i + 1})
			}
		case "include":
			for _, spec := range tokenize(rest) {
				for _, inc := range expandInclude(spec, baseDir) {
					sub, err := scanHosts(inc, baseDir, depth+1, seenFiles)
					if err != nil {
						return nil, err
					}
					out = append(out, sub...)
				}
			}
		}
	}
	return out, nil
}

// collidingHost returns the hand-written declaration of name, if any.
//
// Wildcard patterns and negations are skipped: `Host *` is a rule that applies
// TO hosts, not a declaration OF one, so writing `Host boxb` next to it is
// normal ssh config practice and must not be refused.
func collidingHost(decls []hostDecl, name string) (hostDecl, bool) {
	for _, d := range decls {
		if d.pattern == "" || strings.HasPrefix(d.pattern, "!") || strings.ContainsAny(d.pattern, "*?") {
			continue
		}
		if strings.EqualFold(d.pattern, name) {
			return d, true
		}
	}
	return hostDecl{}, false
}

// parseEntry reads back the fields muxterm itself wrote into a managed block.
// The name comes from the marker rather than the Host line because the marker
// is what identifies the block.
func parseEntry(name, text string) Entry {
	e := Entry{Name: name}
	for _, sp := range lineSpans(text) {
		keyword, rest, ok := splitKeyword(text[sp.start:sp.end])
		if !ok {
			continue
		}
		values := tokenize(rest)
		if len(values) == 0 {
			continue
		}
		switch strings.ToLower(keyword) {
		case "hostname":
			e.HostName = values[0]
		case "port":
			if n, err := strconv.Atoi(values[0]); err == nil {
				e.Port = n
			}
		case "user":
			e.User = values[0]
		case "identityfile":
			e.IdentityFile = values[0]
		}
	}
	return e
}

// splitKeyword separates a config line's keyword from its arguments, returning
// ok=false for blank and comment lines.
//
// ssh accepts either whitespace or '=' between a keyword and its arguments, so
// both are separators here — but only for the keyword, so an '=' inside an
// argument (a path, an option value) survives intact.
func splitKeyword(line string) (keyword, rest string, ok bool) {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return "", "", false
	}
	if i := strings.IndexAny(line, " \t="); i >= 0 {
		keyword = line[:i]
		rest = line[i+1:]
	} else {
		keyword = line
	}
	if keyword == "" {
		return "", "", false
	}
	return keyword, rest, true
}

// tokenize splits a config line's arguments on whitespace, honoring double
// quotes (ssh's own quoting for values containing spaces) and stopping at an
// unquoted '#'.
func tokenize(s string) []string {
	var (
		out     []string
		cur     strings.Builder
		inQuote bool
		started bool
	)
	flush := func() {
		if started {
			out = append(out, cur.String())
			cur.Reset()
			started = false
		}
	}
	for _, r := range s {
		switch {
		case r == '"':
			inQuote = !inQuote
			started = true
		case !inQuote && (r == ' ' || r == '\t' || r == '\r'):
			flush()
		case !inQuote && r == '#':
			flush()
			return out
		default:
			cur.WriteRune(r)
			started = true
		}
	}
	flush()
	return out
}

// expandInclude resolves one Include argument to concrete file paths: ~ is
// expanded, a relative path is taken relative to baseDir, and glob
// metacharacters are expanded. A pattern matching nothing yields nothing.
func expandInclude(spec, baseDir string) []string {
	if spec == "" {
		return nil
	}
	spec = expandHome(spec)
	if !filepath.IsAbs(spec) {
		spec = filepath.Join(baseDir, spec)
	}
	if !strings.ContainsAny(spec, "*?[") {
		return []string{spec}
	}
	matches, err := filepath.Glob(spec)
	if err != nil {
		return nil // a malformed pattern contributes nothing, exactly as in ssh
	}
	return matches
}

// expandHome replaces a leading ~ with the user's home directory, leaving the
// string untouched when there is no home directory to expand to.
func expandHome(spec string) string {
	if spec != "~" && !strings.HasPrefix(spec, "~/") {
		return spec
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return spec
	}
	if spec == "~" {
		return home
	}
	return filepath.Join(home, spec[2:])
}
