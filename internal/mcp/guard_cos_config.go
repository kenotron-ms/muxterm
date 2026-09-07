package mcp

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/cos"
)

// THE CHIEF OF STAFF DOES NOT EDIT ITS OWN CONFIGURATION.
//
// A chief of staff that can rewrite its own instruction can undo any
// restriction placed on it, including the restriction that stops it rewriting
// its own instruction. So the tuning files are a HUMAN-ONLY surface, and this
// file is the enforcement that makes that claim true rather than aspirational.
//
// There are three ways the sidecar could reach those files, and each is
// answered differently:
//
//  1. A FILE-WRITING TOOL. It has none. tool-filesystem mounts read_file,
//     write_file and edit_file together, and the bundle's declared surface
//     (internal/cos/sidecar/bundle/behaviors/muxterm-cos.yaml) names only
//     read_file; _enforce_tool_surface unmounts the other two before the first
//     turn. bash, apply_patch and delegate are withheld the same way.
//
//  2. THE CONFIG API. mcp_muxterm_update_config PATCHes /api/config, which
//     merges through config.Merge and writes config.toml. The tuning does not
//     live in config.Config -- it is files under the muxterm config dir -- so
//     there is no field to merge and no key to filter. The capability does not
//     exist rather than being denied.
//
//  3. A TERMINAL. This is the real one, and the reason this file exists. The
//     chief of staff holds run_command and send_input (a pane is auditable, a
//     hidden bash is not) and spawn_lane and session_send (delegation is its
//     job). Every one of those puts bytes into a shell that runs as this user,
//     and a shell can write any file this user can write. So the muxterm tool
//     layer refuses the attempt.
//
// WHAT THIS IS NOT. It is a mechanism block, not a sandbox. A same-uid process
// outside muxterm -- a shell the human opened themselves, an editor, an agent
// running under a different harness -- can still write these files, and no
// amount of string matching in muxterm changes that. Enforcing it properly
// would need the sidecar's descendants to run as a different uid or in a
// namespace, which is privilege separation and is not this change. What is
// claimed here is exact: no tool muxterm hands to the chief of staff will
// carry an edit to these files, directly or through a lane spawned to do it.
//
// It applies to EVERY caller of these tools, not only to the chief of staff.
// That is deliberate and simpler: these files configure the agent layer, so
// "no agent working through muxterm's terminal tools writes them" is one rule
// with no caller identity to get wrong, and a human at a real terminal is
// unaffected.

// guardCosConfig refuses text that would reach the chief of staff's tuning
// files. It is called with whatever a tool is about to put into a shell or
// hand to a spawned agent.
//
// MATCHING IS ON THE PATH, not on a verb. Trying to recognize "writes" (>,
// tee, sed -i, python, an editor, a heredoc, a git checkout) is a list nobody
// can finish; naming the file is not. A read is refused along with a write,
// which costs a user almost nothing -- `muxterm cos --config` reports the same
// content, and read_file remains available for everything else -- and removes
// the whole argument about which shell constructs count as writing.
func guardCosConfig(texts ...string) error {
	dir, _ := cos.ConfigDir()
	needles := configNeedles(dir)
	for _, text := range texts {
		if text == "" {
			continue
		}
		hay := strings.ToLower(text)
		for _, n := range needles {
			if strings.Contains(hay, n) {
				return fmt.Errorf(
					"refused: %s names the chief of staff's tuning files (%s). "+
						"Those are a human-only surface -- an agent that can rewrite its own "+
						"instruction can undo every restriction placed on it. "+
						"Edit them yourself, and read them with 'muxterm cos --config --full'",
					quoteNeedle(n), dir)
			}
		}
	}
	return nil
}

// configNeedles is the set of substrings that count as naming the tuning.
//
// THE RULE: every needle is a spelling of the config DIRECTORY. Not a list of
// filenames, and not a list of verbs. That keeps the set closed and finite --
// a directory has a handful of spellings, whereas "ways to write a file" is a
// list nobody finishes and "files called instruction.md" is a trap for any
// repo that happens to have one.
//
//	/home/me/.config/muxterm/cos     resolved, absolute
//	~/.config/muxterm/cos            as a human or a shell writes it
//	$XDG_CONFIG_HOME/muxterm/cos     unexpanded, or any other prefix
//
// The last two segments -- muxterm/cos -- are the load-bearing needle: every
// form above ends in them, whatever comes before. It was added after a
// measured miss, not on principle: `cd ~/.config/muxterm/cos && echo hi >
// instruction.md` sailed past a guard that knew only the resolved absolute
// path, because a dev instance's dir is somewhere under /tmp and the tilde
// form shares no prefix with it.
//
// It is specific enough not to catch ordinary work: this repo's own source
// lives at muxterm/internal/cos, and a worktree is muxterm-cos-something --
// neither contains "muxterm/cos".
//
// Lowercased on both sides. Not about correctness on Linux -- about not
// leaving an obvious near-miss that reads as an oversight.
func configNeedles(dir string) []string {
	clean := filepath.Clean(dir)
	needles := []string{
		strings.ToLower(clean),
		// The last two segments, which every spelling of the path ends with.
		strings.ToLower(filepath.Join(filepath.Base(filepath.Dir(clean)), filepath.Base(clean))),
	}
	if home := os.Getenv("HOME"); home != "" && strings.HasPrefix(clean, home+string(filepath.Separator)) {
		needles = append(needles, strings.ToLower("~"+clean[len(home):]))
	}
	return dedupe(needles)
}

func dedupe(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := in[:0]
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func quoteNeedle(n string) string { return "'" + n + "'" }
