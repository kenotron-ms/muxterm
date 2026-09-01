package sessiond

import (
	"path/filepath"
	"regexp"
	"strings"
)

// agentCatalogEntry is one recognized coding-agent CLI: a display Name and a
// Match predicate over a captured argv.
type agentCatalogEntry struct {
	Name  string
	Match func(argv []string) bool
}

// defaultAgentCatalog is the compiled-in, non-configurable allowlist of
// coding-agent CLIs muxterm recognizes for session-restore relaunch. It is
// passed as a plain value to matchAgent rather than baked in as a
// package-level global consumed directly by call sites, so a future
// user-extensible list could be added later without an API change -- that is
// NOT built here.
//
// This 4-entry allowlist is what makes relaunch-without-confirmation safe:
// restoring a pane never executes anything beyond "spawn this exact captured
// argv again, verbatim" for one of these four names; anything else falls
// back to a plain default shell.
func defaultAgentCatalog() []agentCatalogEntry {
	return []agentCatalogEntry{
		{Name: "amplifier", Match: matchArgvBasename("amplifier")},
		{Name: "claude", Match: matchArgvBasename("claude")},
		{Name: "codex", Match: matchArgvBasename("codex")},
		{Name: "opencode", Match: matchArgvBasename("opencode")},
	}
}

// matchArgvBasename returns a Match predicate reporting whether any element
// of argv, once reduced to its final path segment with a common script
// extension stripped, equals name.
//
// Matching the whole argv (not just argv[0]) matters because several of
// these are Node/Bun CLIs: when the OS execs a shebang script named e.g.
// "claude", argv is rewritten to [node, /path/to/claude, ...] -- the
// interpreter becomes argv[0] and the real identity moves to a later
// element. Stripping the extension additionally catches an on-disk shim
// literally named "claude.js"/"claude.mjs"/"claude.cjs".
func matchArgvBasename(name string) func(argv []string) bool {
	return func(argv []string) bool {
		for _, a := range argv {
			base := filepath.Base(a)
			base = strings.TrimSuffix(base, filepath.Ext(base))
			if base == name {
				return true
			}
		}
		return false
	}
}

// matchAgent reports the catalog Name of the first entry whose Match
// predicate accepts argv, trying entries in catalog order. An empty argv
// never matches.
func matchAgent(argv []string, catalog []agentCatalogEntry) (name string, matched bool) {
	if len(argv) == 0 {
		return "", false
	}
	for _, entry := range catalog {
		if entry.Match(argv) {
			return entry.Name, true
		}
	}
	return "", false
}

// amplifierProcTitleRE matches the process-title shape a muxterm-aware
// Amplifier session stamps via setproctitle (see
// modules/hooks-muxterm-session): "amplifier resume <session-id>".
//
// setproctitle rewrites /proc/<pid>/cmdline as a single NUL-terminated
// blob -- verified empirically, not inferred: it does not produce separate
// argv elements the way a normal exec does. So this is matched against
// each argv element as one whole string, not a path/basename the way
// matchArgvBasename works.
var amplifierProcTitleRE = regexp.MustCompile(
	`^amplifier resume ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$`,
)

// matchAmplifierSessionID scans argv for the setproctitle-stamped
// "amplifier resume <id>" shape and returns the extracted session id. This
// is checked independently of, and before, the generic catalog basename
// match in capturePaneSnapshot: a stamped title does not contain a real
// executable basename (matchArgvBasename never matches it -- there is no
// path segment in it equal to "amplifier"), and restorePane must never
// attempt to verbatim-exec it either, since it is cosmetic text meant to
// be read via /proc/<pid>/cmdline, not a real invocation.
func matchAmplifierSessionID(argv []string) (sessionID string, ok bool) {
	for _, a := range argv {
		if m := amplifierProcTitleRE.FindStringSubmatch(a); m != nil {
			return m[1], true
		}
	}
	return "", false
}
