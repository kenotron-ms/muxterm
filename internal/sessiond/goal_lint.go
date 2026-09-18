package sessiond

// Stop-condition lint, applied where a lane's goal is AUTHORED.
//
// WHY THIS EXISTS AT ALL. A /goal lane runs until its stop condition is
// satisfied. A condition that cannot be satisfied does not fail -- it runs
// forever, spending money, and the two recorded worst cases are not close
// calls: two lanes launched with a terminal verb that could only ever refuse
// ran 855 turns / $202.91 and ~887 turns / ~$184, repeating one evaluator line
// for hours after their own work had already merged. Both were structurally
// detectable from the condition text before either lane started.
//
// WHERE THE RULES COME FROM. They are muxterm's mechanical subset of the
// `goalify` skill's Phase 3 lint (L0-L7, W1-W4), whose rules each trace to a
// named /goal run that failed to terminate. muxterm cannot run that lint: it is
// a judgement pass over a whole document, performed by a model that read the
// conversation the condition came from. What muxterm CAN do is the part that is
// decidable from the text alone, at the moment a human or an agent is present
// to be told. The rule ids below are goalify's, deliberately, so a refusal here
// and a lint table there name the same thing.
//
// THE ONE RULE MUXTERM KNOWS BETTER THAN GOALIFY IS ATTENDANCE. goalify lints a
// condition without knowing how it will be launched. muxterm knows: a trigger
// fires with nobody attached, by construction (trigger.go). So a condition that
// waits on a person is a WARNING on an interactive spawn -- a human may well be
// sitting there -- and a BLOCKER on a trigger, where the awaited event can
// never arrive. Same text, different verdict, because muxterm owns the fact
// that decides it. That asymmetry is the reason this file is here rather than
// upstream in the skill.
//
// SEVERITY IS DELIBERATELY LOPSIDED. goalify's own provenance sets the bar for
// promoting a rule to BLOCKER -- a scored corpus, and one of its rules was
// DEMOTED on measurement. muxterm has no corpus. So only findings that are
// token-exact (a named verb is present and its mandatory fallback is not; the
// condition literally restates "/goal") or that muxterm can decide from its own
// launch facts (attendance) are allowed to refuse. Everything else is reported
// verbatim to the caller and launches anyway. A lint that cries wolf gets
// routed around, and a launch path nobody uses protects nothing.
//
// NOTHING HERE RUNS AT FIRE TIME. A trigger authored before this file existed
// keeps firing exactly as it did. Refusing a fire at 3am would be the failure
// mode triggers are built to avoid (trigger.go: "losing triggers means nothing
// fires, which is a bad day"), and the author is not there to be told why. The
// lint runs where somebody can act on it: create_trigger, spawn_lane, and
// `muxterm spawn-lane`. list_triggers re-runs it on every listing, so a trigger
// created before today still shows its findings when a human next looks.

import (
	"fmt"
	"strings"
)

// Finding severities.
const (
	// GoalBlocker refuses the launch. Reserved for findings that are exact.
	GoalBlocker = "blocker"
	// GoalWarning is reported to the caller and does not refuse anything.
	GoalWarning = "warning"
)

// Attendance of the launch path being linted, named so call sites read as
// claims about the world rather than as a bare true/false.
//
// LaneUnattended is what a TRIGGER is: it fires on a clock or a file change, at
// a moment nobody chose to be present for.
const (
	LaneAttended   = false
	LaneUnattended = true
)

// GoalFinding is one lint result: which rule fired, how hard, why it matters,
// and the fragment of the condition that fired it.
//
// Quote is the point. "L4 fired" is an accusation; "L4 fired on `wait for
// approval`" is something an author can fix in one edit without re-reading
// their own condition looking for what upset the machine.
type GoalFinding struct {
	Rule     string `json:"rule"`
	Severity string `json:"severity"`
	Reason   string `json:"reason"`
	Quote    string `json:"quote,omitempty"`
}

// goalQuoteWidth bounds a quoted fragment. Long enough to show the phrase in
// its clause, short enough that a finding stays one line in a tool reply.
const goalQuoteWidth = 72

// LintGoal reports every known termination-failure pattern detectable in goal.
//
// unattended is LaneUnattended when the condition is being authored for a
// trigger, which is what promotes L4 from a warning to a blocker. An empty or
// whitespace-only goal yields no findings: that is not a lint question, it is
// LaneArgv's blank-goal refusal, which already fires first and says so better.
func LintGoal(goal string, unattended bool) []GoalFinding {
	if strings.TrimSpace(goal) == "" {
		return nil
	}
	// Detection runs on a lowered copy and quotes are cut from that same copy,
	// so an index can never land mid-rune or past the end on a condition whose
	// case folding changed its length.
	text := strings.ToLower(goal)

	var out []GoalFinding
	add := func(f GoalFinding) { out = append(out, f) }

	// --- M1: the condition restates the command that wraps it. -------------
	//
	// muxterm's own rule, not goalify's: the goal-lane wrapper runs
	// `amplifier run "/goal $goal"` (goallane.go), so a condition beginning
	// "/goal" produces `/goal /goal ...` and the loop arms on a condition that
	// opens with a slash command. Token-exact, so it refuses.
	if strings.HasPrefix(strings.TrimSpace(text), "/goal") {
		add(GoalFinding{
			Rule:     "M1",
			Severity: GoalBlocker,
			Reason: "the condition begins with \"/goal\", which muxterm already prepends: this lane would run " +
				"`/goal /goal ...` and the loop would arm on a condition that opens with a slash command. " +
				"Pass the condition alone",
			Quote: goalQuote(text, 0),
		})
	}

	// --- L7 (work-tracker): a terminal verb that can refuse. ---------------
	//
	// The most expensive recorded failure, and the cheapest to detect: the
	// verbs are literal tokens. work_resolve and work_release both refuse a
	// session that never held the item, and no amount of further work makes
	// them succeed -- so a condition ending only in those verbs has no
	// reachable terminal state from the moment a sibling resolves the item.
	// work_erratum is append-only and needs no claim, which is exactly why
	// goalify makes naming it mandatory rather than advisory.
	if idx := firstIndexOf(text, "work_resolve", "work_release"); idx >= 0 &&
		!strings.Contains(text, "work_erratum") {
		add(GoalFinding{
			Rule:     "L7",
			Severity: GoalBlocker,
			Reason: "completion is recorded with work_resolve/work_release but work_erratum is never named as the " +
				"fallback. Both refuse a session that does not hold the item, so once a sibling resolves it this " +
				"lane can finish the work and still be unable to record it -- which reads to the evaluator as " +
				"\"not done\" forever. Name work_erratum as the terminal step for that case",
			Quote: goalQuote(text, idx),
		})
	}

	// --- L4: the loop waits on a person. -----------------------------------
	//
	// A condition-checking loop cannot produce the event it is waiting for.
	// Attended, that is a caution: somebody may be watching this pane. For a
	// trigger it is fatal and muxterm is the only party that knows it.
	if idx, quote := matchPhrase(text, goalPhrasesHumanWait); idx >= 0 {
		f := GoalFinding{Rule: "L4", Quote: quote}
		if unattended {
			f.Severity = GoalBlocker
			f.Reason = "a trigger fires this lane with nobody attached, and this condition halts waiting for a " +
				"person -- an event no unattended run can produce, so it can never be satisfied. Make the lane " +
				"record what it needs and reach a terminal state instead of waiting"
		} else {
			f.Severity = GoalWarning
			f.Reason = "the loop halts on an event a condition-checking loop cannot itself produce, so this lane " +
				"only finishes if a human is watching this pane"
		}
		add(f)
	}

	// --- L3: wall-clock time beyond this session. --------------------------
	if _, quote := matchPhrase(text, goalPhrasesWallClock); quote != "" {
		add(GoalFinding{
			Rule:     "L3",
			Severity: GoalWarning,
			Reason: "the condition requires real time to pass beyond this run, which a single session cannot " +
				"advance; it can never be satisfied in-session",
			Quote: quote,
		})
	}

	// --- L5: open enumeration. ---------------------------------------------
	if _, quote := matchPhrase(text, goalPhrasesOpenScope); quote != "" {
		add(GoalFinding{
			Rule:     "L5",
			Severity: GoalWarning,
			Reason: "scope is phrased as an unbounded set, so an evaluator can always name one more item and the " +
				"loop never terminates. Convert it to a closed, named list or to one representative artifact",
			Quote: quote,
		})
	}

	// --- L2: universal quantifier with no per-item terminal. ---------------
	//
	// goalify's own escape clause is honoured: "every X" is fine when each item
	// can resolve to its own PASS / FAIL-named / BLOCKED-named outcome, so the
	// rule does not fire when the condition already carries per-item terminals.
	if !hasPerItemTerminal(text) {
		if _, quote := matchPhrase(text, goalPhrasesQuantifier); quote != "" {
			add(GoalFinding{
				Rule:     "L2",
				Severity: GoalWarning,
				Reason: "a universal quantifier over a set, with no per-item negative terminal: one member that " +
					"cannot structurally produce the required evidence makes the whole condition permanently " +
					"unsatisfiable. Give each item its own PASS / FAIL-named / BLOCKED-named outcome",
				Quote: quote,
			})
		}
	}

	// --- L6: no disjunctive exit. ------------------------------------------
	//
	// A warning in goalify too, and for the same reason: its absence is common
	// in conditions that do terminate, so blocking on it would refuse a great
	// deal of working work. It is still the single most useful thing to add.
	if !hasDisjunctiveExit(text) {
		add(GoalFinding{
			Rule:     "L6",
			Severity: GoalWarning,
			Reason: "no disjunctive exit: this condition can only end by succeeding. State the other ending too -- " +
				"reached, OR conclusively shown unreachable, naming the blocker -- or the only ways out are " +
				"external rescue and a cap",
		})
	}

	// --- L7 (infrastructure): provisioned, never torn down. ----------------
	if _, quote := matchPhrase(text, goalPhrasesProvisions); quote != "" {
		if !containsAny(text, goalPhrasesTeardown...) {
			add(GoalFinding{
				Rule:     "L7-infra",
				Severity: GoalWarning,
				Reason: "the condition stands up something that outlives the run but never makes teardown-complete, " +
					"or a named handoff to an owner, part of DONE. A satisfied goal that leaves resources running " +
					"and unowned is abandoned, not finished",
				Quote: quote,
			})
		}
	}

	return out
}

// CheckGoal refuses a condition carrying any blocker-severity finding, naming
// every one of them.
//
// All blockers in one error rather than the first: an author fixing a condition
// should not discover the second refusal only after paying for the first edit.
// Warnings are not this function's business -- callers report them alongside a
// launch that happened.
func CheckGoal(goal string, unattended bool) error {
	var blockers []GoalFinding
	for _, f := range LintGoal(goal, unattended) {
		if f.Severity == GoalBlocker {
			blockers = append(blockers, f)
		}
	}
	if len(blockers) == 0 {
		return nil
	}
	parts := make([]string, 0, len(blockers))
	for _, f := range blockers {
		part := fmt.Sprintf("%s: %s", f.Rule, f.Reason)
		if f.Quote != "" {
			part += fmt.Sprintf(" (fired on %q)", f.Quote)
		}
		parts = append(parts, part)
	}
	return fmt.Errorf("this stop condition cannot terminate as written, so the lane was not started -- %s",
		strings.Join(parts, "; "))
}

// GoalLintWarnings returns the warning-severity findings only, for a caller
// that has already passed CheckGoal and wants to report what it launched with.
func GoalLintWarnings(goal string, unattended bool) []GoalFinding {
	var out []GoalFinding
	for _, f := range LintGoal(goal, unattended) {
		if f.Severity == GoalWarning {
			out = append(out, f)
		}
	}
	return out
}

// --- phrase tables ---------------------------------------------------------
//
// Every entry is lowercase and is matched as a substring under the negation
// guard in matchPhrase. They are deliberately SPECIFIC: a rule that fires on
// "monitor" catches every condition that mentions watching anything, and the
// first thing an author learns from a lint that fires constantly is to stop
// reading it.

// goalPhrasesHumanWait: the loop halts on a person.
var goalPhrasesHumanWait = []string{
	"wait for approval",
	"wait for the user",
	"wait for a human",
	"wait for me",
	"waiting for approval",
	"waiting for a human",
	"waiting on a human",
	"waiting for the user",
	"once a reviewer",
	"once a human",
	"once the user confirms",
	"once i approve",
	"until the user confirms",
	"until i confirm",
	"until a human",
	"until i approve",
	"ask me first",
	"ask me before",
	"stop and ask me",
	"check with me",
	"get my approval",
	"human approval",
	"await approval",
	"pause for review",
}

// goalPhrasesWallClock: time that a session cannot advance.
var goalPhrasesWallClock = []string{
	"soak",
	"days of use",
	"weeks of use",
	"real-world use",
	"real world use",
	"monitor over time",
	"over the next day",
	"over the next week",
	"over the next month",
	"over several days",
	"after a week",
	"after several days",
	"burn-in",
	"burn in period",
}

// goalPhrasesOpenScope: a set an evaluator can always add one more item to.
var goalPhrasesOpenScope = []string{
	"complete parity",
	"full parity",
	"feature parity",
	"everything needed",
	"all editing features",
	"and so on",
	"and everything else",
	"fully support",
	"all remaining",
	"etc.",
}

// goalPhrasesQuantifier: universal quantifiers, checked only when no per-item
// terminal exists.
var goalPhrasesQuantifier = []string{
	"every single",
	"all of the",
	"each of the",
	"for each of",
	"across all ",
	"uniformity",
	"uniform across",
}

// goalPhrasesProvisions: things that outlive the run.
var goalPhrasesProvisions = []string{
	"docker",
	"container",
	"incus",
	"virtual machine",
	"background server",
	"dev server",
	"kubernetes",
	"provision",
	"compose up",
	"tunnel",
}

// goalPhrasesTeardown: any of these anywhere in the condition satisfies the
// infrastructure rule. Checked over the WHOLE text, not near the match: a
// condition that names teardown in its DONE section has met the requirement
// however far that is from where the container was mentioned.
var goalPhrasesTeardown = []string{
	"teardown",
	"tear down",
	"torn down",
	"tears down",
	"clean up",
	"cleaned up",
	"cleanup",
	"handoff",
	"hand off",
	"handed off",
	"remove the container",
	"stop the container",
	"destroy",
}

// goalPhrasesPerItemTerminal: evidence that items resolve individually, which
// is goalify's stated escape from L2.
var goalPhrasesPerItemTerminal = []string{
	"fail-",
	"blocked-",
	"pending-human",
	"per-item",
	"per item",
	"residual",
	"its own terminal",
	"pass / fail",
	"pass/fail",
}

// goalPhrasesDisjunctiveExit: evidence that the condition states a second way
// to end. Matched WITHOUT the negation guard -- "cannot be reached" is the
// wanted phrasing here, and a guard looking for "not" would reject the very
// shape the rule is asking for.
var goalPhrasesDisjunctiveExit = []string{
	"conclusively",
	"cannot be reached",
	"cannot be achieved",
	"cannot be done",
	"not achievable",
	"unreachable",
	"naming the blocker",
	"name the blocker",
	"or demonstrate",
	"or show that",
	"or it is shown",
	"or conclusively",
	"impossible",
	"blocked-",
	"is a residual",
	"residuals",
}

// --- matching ---------------------------------------------------------------

// matchPhrase returns the index and a quotable fragment for the first phrase
// that appears in text and is not negated.
//
// THE NEGATION GUARD is the whole reason this is not strings.Contains. A stop
// condition is prose written by somebody who has been told what goes wrong, so
// "do NOT wait for approval" and "never ask me first" are exactly the sentences
// a careful author writes -- and firing on them would punish the authors who
// read the rules. It looks back a short distance for a negator and skips the
// match when it finds one; it does not parse English, and it is not trying to.
func matchPhrase(text string, phrases []string) (int, string) {
	best := -1
	for _, phrase := range phrases {
		from := 0
		for {
			rel := strings.Index(text[from:], phrase)
			if rel < 0 {
				break
			}
			idx := from + rel
			if !negatedAt(text, idx) {
				if best < 0 || idx < best {
					best = idx
				}
				break
			}
			from = idx + len(phrase)
		}
	}
	if best < 0 {
		return -1, ""
	}
	return best, goalQuote(text, best)
}

// goalNegationWindow is how far back a negator can sit and still apply. Short
// on purpose: "not" three clauses earlier is about something else.
const goalNegationWindow = 26

var goalNegators = []string{"not ", "n't ", "never ", "no ", "without ", "avoid ", "rather than "}

// negatedAt reports whether the match at idx is preceded by a negator inside
// the window.
func negatedAt(text string, idx int) bool {
	start := idx - goalNegationWindow
	if start < 0 {
		start = 0
	}
	return containsAny(text[start:idx], goalNegators...)
}

// containsAny reports whether text contains any of the needles.
func containsAny(text string, needles ...string) bool {
	for _, n := range needles {
		if strings.Contains(text, n) {
			return true
		}
	}
	return false
}

// firstIndexOf returns the lowest index at which any needle occurs, or -1.
func firstIndexOf(text string, needles ...string) int {
	best := -1
	for _, n := range needles {
		if i := strings.Index(text, n); i >= 0 && (best < 0 || i < best) {
			best = i
		}
	}
	return best
}

// hasPerItemTerminal reports whether the condition lets an item end on its own.
func hasPerItemTerminal(text string) bool {
	return containsAny(text, goalPhrasesPerItemTerminal...)
}

// hasDisjunctiveExit reports whether the condition names a second way to end.
func hasDisjunctiveExit(text string) bool {
	return containsAny(text, goalPhrasesDisjunctiveExit...)
}

// goalQuote cuts a readable fragment around idx, collapsing whitespace so a
// multi-line condition still quotes as one line.
func goalQuote(text string, idx int) string {
	if idx < 0 || idx >= len(text) {
		return ""
	}
	end := idx + goalQuoteWidth
	if end > len(text) {
		end = len(text)
	}
	frag := strings.Join(strings.Fields(text[idx:end]), " ")
	if end < len(text) {
		frag += "..."
	}
	return frag
}
