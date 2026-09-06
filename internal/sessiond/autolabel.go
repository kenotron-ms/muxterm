package sessiond

import (
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Pane labels derived, at spawn, from the argv a session was started with.
//
// The home composer does not open a shell and type at it -- it starts a
// coding-agent CLI with the user's first prompt as a positional argument (see
// web/src/lib/harness.ts). So at the instant createPane runs, the daemon is
// already holding the only description of the work that exists anywhere, and
// it is holding it before the child process has drawn a single byte.
//
// That is the whole reason this is done here rather than by something smarter
// later. A label that arrives thirty seconds after the tab does is a tab that
// reads "Pane 7" for thirty seconds. This path has no model in it, no provider
// credentials, no subprocess and no round trip, so it cannot be slow and it
// cannot be unavailable on somebody else's machine. It is the permanent floor
// under any later refinement, not a placeholder to be tolerated until one
// lands (see docs/designs/2026-09-05-auto-naming-from-session-design.md).
//
// The rules below are deliberately literal rather than general. Exactly two
// harness argv shapes are recognised because exactly two are produced;
// anything else -- a bare $SHELL, vim, a hand-typed command -- yields no
// prompt and therefore no title, and the pane keeps the "Pane N" fallback the
// browser already renders. Inventing a label for a pane nobody described is
// worse than leaving it unlabelled, because a wrong tab name is a tab you
// cannot find twice.

// maxLabelWords and maxLabelChars bound the label to something a pane tab can
// show whole. Truncation is the failure to avoid here: it eats the end of the
// words that distinguish two tabs from each other, which is precisely the
// information the label exists to carry, so a shorter label is strictly
// better than a clipped one.
const (
	maxLabelWords = 3
	maxLabelChars = 24
)

// labelStopwords are the words that never distinguish one session from
// another. Dropping them is what turns a sentence into a label.
//
// The set is compared against lowercased, outer-punctuation-stripped words, so
// "This:" and "this" are one entry. It is grouped for readability only; the
// lookup does not care which group a word came from.
var labelStopwords = wordSet(
	// English scaffolding, plus the generic modifiers ("new", "current",
	// "another") that read as emphasis and identify nothing.
	`a about all also am an and another any are as at be been being but by can
	 could current did do does doing don't dont each even every existing for
	 from had has have having here how i i'd i'll i'm if in into is it it's its
	 just me more most my new no not now of off on once only or other our out
	 over own please same should so some such than that the their them then
	 there these they this those to too up us very was we were what when where
	 which while who why will with would you your` +

		// The vocabulary of ASKING rather than of describing. Every prompt to a
		// coding agent opens with some arrangement of "I want you to", "make
		// sure you", "figure out a way to", "new worktree for you to work on
		// this" -- and none of it says what the work is about. The nouns for
		// the act of asking itself ("muxterm feedback:", "a note about",
		// "question:") are here for the same reason.
		` add added adding build building change changing create created
	 creating figure fix fixed fixes fixing get gets getting help implement
	 implementing keep know let lets like look looking make makes making maybe
	 need needed needs remove removing see seeing sure thing things think try
	 trying update updating use using want wanted wants way ways work working
	 worktree worktrees write writing feedback note notes question request` +

		// The repository's own name, which labels nothing inside its own
		// repository -- every prompt here is about muxterm. A component name
		// that merely starts with it ("muxterm-sessiond") is a different
		// matter and deliberately survives: that one does say which part.
		` muxterm`,
)

// wordSet turns a whitespace-separated word list into a lookup set. The list
// above is written as prose so it stays readable and reviewable in a diff;
// splitting it once at process start costs nothing worth weighing against
// that.
func wordSet(words string) map[string]struct{} {
	set := make(map[string]struct{})
	for _, w := range strings.Fields(words) {
		set[w] = struct{}{}
	}
	return set
}

// promptFromArgv returns the human-written prompt a harness was launched with,
// or "" when argv is not one of the shapes the composer produces:
//
//	amplifier run <prompt> --mode chat
//	claude <prompt>
//
// Those two are matched literally, straight off web/src/lib/harness.ts. A
// general "find the argument that looks like English" heuristic was
// deliberately not written: it would have to guess about flags it has never
// seen, and guessing wrong means a pane titled after a file path or a model
// name. The composer is the only thing that puts a prompt in argv and it emits
// exactly these two forms, so recognising exactly these two forms is both
// sufficient and honest about what is actually known.
func promptFromArgv(argv []string) string {
	if len(argv) == 0 {
		return ""
	}
	// A harness invoked by absolute path, or installed as a "claude.js" shim,
	// is still the harness -- the same normalisation matchArgvBasename applies
	// for the agent catalog, for the same reason.
	base := filepath.Base(argv[0])
	base = strings.TrimSuffix(base, filepath.Ext(base))

	switch base {
	case HarnessAmplifier:
		// Only `amplifier run <prompt>` carries one. `amplifier resume <id>`
		// and a bare REPL launch have no prompt to find, and argv[2] being a
		// flag means `run` was given none.
		if len(argv) >= 3 && argv[1] == "run" && !isArgvFlag(argv[2]) {
			return argv[2]
		}
	case HarnessClaude:
		// The prompt is positional. The composer passes no flags at all, so
		// the first non-flag argument is it.
		for _, arg := range argv[1:] {
			if !isArgvFlag(arg) {
				return arg
			}
		}
	}
	return ""
}

// isArgvFlag reports whether an argv element is an option rather than a value.
func isArgvFlag(arg string) bool {
	return strings.HasPrefix(arg, "-")
}

// labelFromPrompt reduces a prompt to a tab-sized label, or "" when nothing in
// it says anything -- an all-stopword prompt names the pane not at all rather
// than badly.
func labelFromPrompt(prompt string) string {
	line := firstMeaningfulLine(prompt)
	if line == "" {
		return ""
	}
	var (
		words []string
		total int
	)
	for _, field := range strings.Fields(line) {
		word := normalizeLabelWord(field)
		if word == "" {
			continue
		}
		if utf8.RuneCountInString(word) > maxLabelChars {
			// A word that cannot fit on its own is an identifier -- a URL, a
			// path, a hash -- not a label. Skipping it rather than truncating
			// it lets the real words that follow be found; truncating it would
			// spend the entire budget on a fragment of something unreadable.
			continue
		}
		if _, stop := labelStopwords[word]; stop {
			continue
		}
		cost := utf8.RuneCountInString(word)
		if len(words) > 0 {
			cost++ // the joining space
		}
		if total+cost > maxLabelChars {
			break
		}
		words = append(words, word)
		total += cost
		if len(words) == maxLabelWords {
			break
		}
	}
	return strings.Join(words, " ")
}

// firstMeaningfulLine picks the line of a prompt a human would read as its
// subject. It mirrors _first_line() in the Amplifier hook
// (modules/hooks-muxterm-session/.../state.py) on purpose: two producers of a
// session's name that disagree about where that name starts would name the
// same session two different things.
//
// The slash-command rule is the part that earns the function. A goal lane is
// launched headless as `/goal <the entire goal file>`, so the raw prompt is
// kilobytes of markdown whose first word is a command name shared by every
// such lane. Stripping it leaves the human's own opening sentence; a bare
// `/goal` alone on a line strips to nothing and falls through to the next line
// rather than naming every lane after the command.
func firstMeaningfulLine(prompt string) string {
	for _, raw := range strings.Split(prompt, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "/") {
			i := strings.IndexFunc(line, unicode.IsSpace)
			if i < 0 {
				continue
			}
			line = strings.TrimSpace(line[i:])
			if line == "" {
				continue
			}
		}
		// A markdown heading marker is decoration on the line, not part of it.
		line = strings.TrimSpace(strings.TrimLeft(line, "#"))
		if line != "" {
			return line
		}
	}
	return ""
}

// normalizeLabelWord lowercases one whitespace-delimited field and strips the
// punctuation around it, so "This:", "this" and "(this)" are the same word and
// a lone "-" is no word at all.
//
// Punctuation INSIDE the word is kept deliberately: "muxterm-sessiond" and
// "don't" are each one word, and splitting them would produce a meaningless
// fragment in the first case and a missed stopword in the second.
func normalizeLabelWord(field string) string {
	return strings.ToLower(strings.TrimFunc(field, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}))
}
