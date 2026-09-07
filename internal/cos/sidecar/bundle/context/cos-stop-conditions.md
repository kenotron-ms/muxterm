# Writing a stop condition

Every `spawn_lane(..., goal=...)` you make is a stop condition you wrote. The
lane runs unattended until an evaluator decides that condition is met, so a
badly-formed one does not fail loudly — it runs forever, or it stops on the
first turn. Check every condition against the rules below before you send it.

## It must satisfy all of these

**A checkable end state, not an activity.** "a usable app" can be checked;
"finish building the project" cannot — there is no test for "finished
building".

**A disjunctive exit.** Satisfiable *either* by reaching the end state *or* by
conclusively showing it cannot be reached, naming the blocker. A condition with
only one exit has no way to end when the world says no.

**Per-item negative terminals, if it lists items.** Each item resolves to its
own pass / fail / blocked-with-named-reason. A blocker on one item converts
*that item* to a residual; it must not hold the whole goal hostage.

**An explicit scope-out list.** What is *not* required, stated as plain
negatives: "No production soak required." "Uniformity across all N is NOT the
goal."

## It must contain none of these

**No elapsed wall-clock requirement.** "soak in production", "after a few days",
"monitor over time". A session cannot make time pass; this can never be
satisfied.

**No human in the loop mid-run.** "ask me if you need a decision", "once a
reviewer merges it", "wait for approval". The lane will halt on an event the
loop cannot produce. Front-load the decision into the condition instead.

**No open enumeration.** "all editing features", "complete parity with X",
"everything needed to fully support Y". An evaluator can always name one more
item, so it never terminates. Give a closed, named list, or one representative
artifact.

**No universal quantifier over a set whose members may not all be able to
comply.** "all N", "every X", "uniform", "complete parity" — allowed only when
each member carries its own negative terminal, or the condition names which
members are exempt and why. Otherwise a single structurally-exempt member makes
the whole thing permanently unsatisfiable.

**No requirement about what already happened.** A condition cannot ask for
evidence that precedes events already in the lane's history. Constrain future
actions only; nothing a later turn does can change an earlier one.

**No teardown left implicit.** If the goal stands up anything that outlives the
run — a container, a server, an environment — then teardown, or a named handoff
to an owner, is part of done. A goal that finishes leaving resources running and
unowned is abandoned, not finished.

## Then re-read the whole thing once

An escape hatch is only as strong as the strictest other sentence in the same
condition. A textbook-perfect exit clause is routinely defeated by one unrelated
line elsewhere that quietly re-imposes a forever-requirement. Confirming the
exit exists is not enough — confirm nothing else outranks it.

## Write it as instructions, never as a story

State requirements directly. Do not write "so this doesn't stall like last
time" or any other cautionary anecdote: the evaluator reads the condition too,
and turns the anecdote into a criterion you did not mean to set.

## Shape

```
<one sentence naming the checkable end state>.

Done when: <end state reached>, OR <conclusively shown not achievable, with the
blocker named>.

SCOPE-OUTS:
- <not required>
- <not required>

KNOWN (speed aid only, not a criterion):
- <fact already established, so the lane does not re-derive it>
```

`spawn_lane` takes this as a plain string. There is no file to write, and you
have no tool to write one with.
