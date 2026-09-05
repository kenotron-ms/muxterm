package ssh

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/transport"
)

// maxIncludeDepth matches OpenSSH's own limit on nested Include directives and
// is what stops a cycle of files including each other.
const maxIncludeDepth = 16

// Discover enumerates the Host blocks in ~/.ssh/config, following Include
// directives.
//
// The ssh config is the ONLY listable source for this transport.
// ~/.ssh/known_hosts cannot be used: entries are hashed (|1|…) by default, so
// the file is unenumerable by design. Everything else is manual entry, which
// always remains available.
//
// A missing config file is not an error — it means "nothing to report" and
// returns an empty slice with a nil error.
func (t *Transport) Discover(ctx context.Context) ([]transport.HostRef, error) {
	out := []transport.HostRef{}

	home, err := os.UserHomeDir()
	if err != nil {
		// No home directory means no user ssh config to enumerate. Manual
		// entry still works, so this is "nothing to report", not a failure.
		return out, nil
	}
	sshDir := filepath.Join(home, ".ssh")
	cfg := filepath.Join(sshDir, "config")
	if _, err := os.Stat(cfg); err != nil {
		return out, nil
	}

	seen := make(map[string]bool)
	aliases, err := parseHostAliases(ctx, cfg, sshDir, home, 0, seen)
	if err != nil {
		return nil, err
	}
	for _, a := range aliases {
		out = append(out, transport.HostRef{
			ID:          "ssh:" + a,
			DisplayName: a,
			Addr:        a,
		})
	}
	return out, nil
}

// parseHostAliases returns the connectable Host aliases declared in path and in
// every file it Includes, in declaration order. seen dedupes aliases across the
// whole traversal; depth bounds Include recursion.
func parseHostAliases(ctx context.Context, path, sshDir, home string, depth int, seen map[string]bool) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if depth > maxIncludeDepth {
		return nil, fmt.Errorf("ssh config %s: Include nested deeper than %d levels", path, maxIncludeDepth)
	}
	data, err := os.ReadFile(path) //nolint:gosec
	if err != nil {
		if os.IsNotExist(err) {
			// An Include naming a file that does not exist is legal in ssh and
			// simply contributes nothing.
			return nil, nil
		}
		return nil, fmt.Errorf("read ssh config %s: %w", path, err)
	}

	var aliases []string
	for _, line := range strings.Split(string(data), "\n") {
		keyword, rest, ok := splitKeyword(line)
		if !ok {
			continue
		}
		switch strings.ToLower(keyword) {
		case "host":
			for _, pattern := range tokenize(rest) {
				if !connectableHost(pattern) || seen[pattern] {
					continue
				}
				seen[pattern] = true
				aliases = append(aliases, pattern)
			}
		case "include":
			for _, spec := range tokenize(rest) {
				for _, inc := range expandInclude(spec, sshDir, home) {
					sub, err := parseHostAliases(ctx, inc, sshDir, home, depth+1, seen)
					if err != nil {
						return nil, err
					}
					aliases = append(aliases, sub...)
				}
			}
		}
	}
	return aliases, nil
}

// connectableHost reports whether a Host pattern names something that can
// actually be dialed. Patterns containing * or ? match hosts, they are not
// hosts, and a leading ! is a negation — none of the three is connectable.
func connectableHost(pattern string) bool {
	if pattern == "" {
		return false
	}
	if strings.HasPrefix(pattern, "!") {
		return false
	}
	return !strings.ContainsAny(pattern, "*?")
}

// splitKeyword separates a config line's keyword from its arguments, returning
// ok=false for blank and comment lines.
//
// ssh accepts either whitespace or '=' between a keyword and its arguments, so
// both are separators here — but only for the keyword, so an '=' inside an
// argument (a path, an option value) survives intact.
//
// Unlike OpenSSH this also treats a '#' token as starting a comment for the
// rest of the line. OpenSSH only honors '#' as the FIRST token, which means
// `Host boxb # my laptop` genuinely declares hosts named "#" and "my". Since
// this output is a list shown to a human, dropping the comment is the useful
// divergence.
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
// unquoted '#' comment.
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
// expanded, a relative path is taken relative to ~/.ssh (ssh's rule for a user
// config), and glob metacharacters are expanded. A pattern matching nothing
// yields nothing.
func expandInclude(spec, sshDir, home string) []string {
	if spec == "" {
		return nil
	}
	switch {
	case spec == "~":
		spec = home
	case strings.HasPrefix(spec, "~/"):
		spec = filepath.Join(home, spec[2:])
	case !filepath.IsAbs(spec):
		spec = filepath.Join(sshDir, spec)
	}
	if !strings.ContainsAny(spec, "*?[") {
		return []string{spec}
	}
	matches, err := filepath.Glob(spec)
	if err != nil {
		return nil // malformed pattern contributes nothing, exactly as in ssh
	}
	return matches
}
