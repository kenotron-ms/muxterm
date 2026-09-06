# Auto-naming: panes, workspaces, and the summary line

## Outcome

You type a prompt into the composer and hit send. Within a second the tab reads
**`auth redirect`**, not `Pane 7`. The workspace card reads **`auth redirect`**, not
`workspace 3`. The home row underneath reads a sentence — *"Tracing why the MSAL callback
loops on refresh"* — and keeps reading like a sentence for the whole run, not
`bash: grep -rn "redirect_uri" .`.

Three surfaces, one derived label plus one derived sentence. Nothing else changes.

## What is actually broken today

| Surface | Today | Source |
|---|---|---|
| Pane tab | `Pane 7` | `mux-dock.ts:435-441` fallback — `Pane.Title` is never set. `pane.go:23` calls titles "a later phase." |
| Workspace card | `workspace 3` | `workspace-picker.ts:11-15` fallback — `Workspace.Name` is only ever set by a human dblclick. |
| Home row title | first line of the prompt, clipped to N chars | `_first_line()`, `state.py:212-236`. Truthful, but it is a truncation, not a label. |
| Home row summary, **turn finished** | a real sentence | `classify.py` — already an LLM call. **This part works.** |
| Home row summary, **turn running** | `bash: find . -name '*.go' \| wc -l` | `_describe_tool()`, `state.py:703-708`. A tool echo standing in for a sentence. |

So the honest scope is smaller than "build auto-naming": the summary infrastructure already
exists and already calls a model. Two of the five rows above are genuinely missing, and one
is a regression in disguise.

## Scope and non-goals

In scope:

- A **label** — 1–3 words — derived per session and fanned out to pane title and workspace
  name.
- A **running sentence** — the mid-turn `doing` line stops echoing tool argv.
- The provenance bit that stops the deriver from clobbering a human's rename.

Not in scope:

- OSC 0/2 title capture (`tracked.go:195-213` parses it, `VTBuffer` does not; separate job).
- Naming panes that were not started by a harness — a bare `$SHELL` pane keeps `Pane 7`.
- Renaming a workspace that already holds more than one session.
- Any new frontend rendering. `mux-dock` and `workspace-picker` already render
  `pane.title` / `ws.name`; giving them values is the whole frontend change.

## The one decision that shapes everything: who names?

There are three candidate namers and only one right answer.

| Candidate | Verdict |
|---|---|
| **Go daemon, with its own LLM client** | **No.** `internal/ai/client.go` exists but is gated behind an opt-in stored Anthropic key (`keystore.go`, `ErrDisabled`). A naming feature that works only for people who pasted an API key into muxterm is the worst failure shape available — invisible, and only on other people's machines. This is the same argument `classify.py:21-32` already made and won. |
| **Go daemon shelling out to `amplifier`** | **No.** Nothing in the repo shells out to `amplifier` for inference, and starting now means a subprocess, a cold start, and a second auth path per pane. |
| **The Python hook, via `coordinator.get("providers")`** | **Yes.** It runs *inside* the session being named, using the provider that session already authenticated. Zero new config, zero new keys, and it cannot drift from the session it describes. |

**The hook names. The daemon distributes.** That is the whole architecture.

And the label rides on a call that already happens — `classify_turn()` fires at every
`prompt:complete` (commit `6cfdac0` deliberately removed the pre-filter). Adding a `label`
field to `_SCHEMA` costs **zero additional LLM calls**.

## Design

### Two tiers: instant, then good

A label that arrives 30 seconds after the tab does is a tab that reads `Pane 7` for 30
seconds. So there are two tiers, and the first one has no model in it at all.

**Tier 0 — at spawn, deterministic, in Go.** The composer already ships the prompt to the
daemon as `msg.Cmd[2]` (`server.go:588`; `harness.ts:51` builds
`['amplifier','run',<prompt>,'--mode','chat']`). `createPane` derives a label from it by
dropping a stopword list and taking the first 2–3 surviving words, then `SetTitle`s the pane
before `PutPane`. No latency, no dependency, no failure mode. `"fix the auth redirect loop
on refresh"` → `auth redirect`.

**Tier 1 — at first `prompt:submit`, from the model.** A small dedicated call: one prompt in,
1–3 words out. It overwrites Tier 0 exactly once, within a second or two of the tab
appearing.

Tier 0 is not a placeholder to be tolerated until Tier 1 lands — it is the permanent floor.
If the provider is down or the timeout blows, the tab still reads `auth redirect`. Every
failure path in `classify.py` already returns `None` meaning "keep what you had," and that
contract extends unchanged to the label.

#### Revision: why Tier 1 moved off `prompt:complete`

The original plan hung `label` on the existing `_SCHEMA`, so it would ride the
end-of-turn classifier for **zero additional LLM calls**. That is still true and it is
still tempting. It is also wrong, and Tier 0's real output is what proves it.

Measured against five actual prompts from the live spool:

| Prompt (opening) | Tier 0 label | |
|---|---|---|
| `for muxterm: another worktree to work this...` | `sessions composer` | ok |
| `I want a new worktree for you to work on this: muxterm needs a mobile friendly...` | `mobile friendly` | weak — the subject is *mobile nav* |
| `I want you to figure out a way to maybe have a muxterm instance that can communicate...` | `instance communicate` | weak |
| `make sure you don't freak out with the current muxterm and muxterm-sessiond...` | `freak muxterm-sessiond` | **wrong** |
| `muxterm feedback: New worktree to get this fixed: when I moved away from the home...` | `moved away home` | **wrong** |

Two of five are actively misleading. That is not a bug in the stopword list — these prompts
are *conversational* (`"I want you to figure out a way to maybe..."`), which is precisely the
shape word-frequency extraction handles worst. Tuning the list to fix `freak` is overfitting
to one sentence, and the next prompt breaks it again.

So the question is not "how good can Tier 0 get" — it is **how long a wrong label is allowed
to stay on screen.** At `prompt:complete` that window is the length of a turn: thirty
seconds, often several minutes. A confidently wrong tab for three minutes is worse than
`Pane 7` for three minutes, because you believe it.

The prompt is already in hand at `prompt:submit`. Labelling there costs **one extra call per
session** — not per turn — for a request that is one short prompt in and three words out. A
session lives for minutes to hours; this is noise.

It is also the *more correct* moment. A tab label's job is to help you find the session you
started, so it should describe **what you asked for**, not what the assistant concluded. The
end-of-turn text is the right source for `doing` and the wrong source for a name.

Consequence: `_SCHEMA` in `classify.py` is left alone. Labelling becomes its own small path
asking its own question, and the classifier keeps asking only "is this blocked, and what
happened." Two questions, two moments, no coupling.

### Derive once, then stop

The label is set at the first `prompt:complete` and **never recomputed**. This is the single
most important behavioural rule in the design.

A tab whose name changes every thirty seconds is worse than a tab named `Pane 7`, because
now you cannot find it twice. The `doing` sentence is the thing that moves; the label is the
thing that holds still so you can aim at it. `SessionRecord.flush()` already suppresses
writes when the rendered payload is unchanged (`state.py:373-386`), so a stable label costs
exactly one write.

### Never clobber a human

`Pane.Title` and `Workspace.Name` gain a provenance bit — `derived` vs `explicit`.

- The public rename verbs (`rename-pane`, `rename-workspace`, from browser dblclick, CLI
  `muxterm pane rename`, MCP `rename_pane`) mark **explicit**.
- The deriver writes through a separate internal path and **only** when the field is empty
  or `derived`.
- The bit persists in `paneSnapshot` (`snapshot.go:60`, `:202`, `:579`) or a user rename
  silently reverts after a crash-recovery restart.

Without this, the deriver and the user's dblclick fight on a one-second tick. With it, a
human rename is final.

### The distribution seam

`sessionStore.collect()` already resolves every session row to `(workspaceID, paneID)` via
`paneRef` (`sessionstore.go:313`, `:335`, `placeSnapshot` `:424-431`). That join is the
insertion point — it exists, it runs on the 1s tick, and nothing else has to be built.

In `emitSessionState` (`server.go:1124-1141`), for each row carrying a label:

```
pane:      title empty or derived  ->  reg.RenamePane(wsID, paneID, label)
                                       -> existing TypePaneRenamed broadcast, free
workspace: name empty or derived
           AND workspace holds exactly one session
                                   ->  reg.RenameWorkspace(wsID, label)
                                       -> existing workspace-list re-broadcast
```

The frontend path from `TypePaneRenamed` to a repainted tab already works end to end
(`state.ts:287-291` → `mux-dock.ts:1181-1197`) — it is exercised today by MCP renames.

**The one-session guard on workspaces** is the answer to "a workspace can hold N panes."
A workspace usually *is* one task, so name it after that task; the moment it holds a second
session, stop touching it. It keeps the name it started with, which still reads as the topic
it began as. No voting, no re-derivation, no surprise renames of a workspace you are using.

### The running sentence

This is the part that is a regression rather than a gap. Mid-turn, `doing` is
`_describe_tool()` output — argv, not English. The end-of-turn sentence was added in
`74aa112`; the running case never got one.

Fix it **without** adding an LLM call per tool invocation, which would be absurd:

- `_describe_tool()` gets a real template layer — `grep`/`rg` → *"Searching for X"*, file
  writes → *"Editing state.py"*, `delegate` → *"Delegating to explorer"*. Most tool calls
  have an obvious English form and no model is needed to produce it.
- The first prompt supplies a standing "what this session is for" line that the row falls
  back to when the tool has no good template, so the row never degrades to raw argv.

Only if that proves insufficient in real use does a debounced mid-turn classifier call
become justifiable — and it should be argued for with a screenshot of a bad row, not
assumed now.

## Wire changes

`label` is a new optional field, and this repo has an explicit change-one-change-all
contract for those:

| File | Change |
|---|---|
| `state.py:319-356` | emit `label` in `to_payload()` |
| `internal/sessiond/sessionstate.go:122-181` | `Label string \`json:"label,omitempty"\`` |
| `internal/sessiond/sessionstore.go:553-582` | **add `Label` to `sessionStateHash`** |
| `web/src/lib/session-state.ts:92-123` | `label?: string` |
| `docs/session-state-protocol.md` | optional-fields table |

The hash line is the one that bites: `sessionStateHash` deliberately excludes `UpdatedAt`,
so a new field left out of the hash changes and is *silently never published*. It has to go
in.

## Verification

Per `AGENTS.md`: no unit tests. Browser verification via `/muxterm-verify` and
`playwright-cli`, on a **fresh workspace per run**.

1. Compose `"fix the auth redirect loop"` → **within ~1s** the tab reads a 1–3 word label,
   not `Pane 7`. (Tier 0, no model involved.)
2. Let the first turn finish → the label refines once, and the home row shows a sentence.
3. Let a second turn finish → **the label does not change.** This is the churn test and the
   easiest one to fail.
4. Dblclick-rename the workspace → wait through several ticks → **the name sticks.** This is
   the clobber test.
5. Open a second session in the same workspace → the workspace name does not change.
6. Kill the provider (bad key / `classify_end_of_turn: false`) → the Tier 0 label survives
   and nothing regresses to `Pane 7`.
7. Restart sessiond after a manual rename → the explicit name survives crash recovery.

## Open question for the human

The composer's workspace `<select>` is **decorative today** — `web/src/app.ts:1692-1707`
destructures `d.workspaceId` and never uses it, so "New workspace" silently drops the pane
into whatever workspace the connection is attached to.

Auto-naming workspaces from the composer is not fully meaningful until that is real. It is a
small fix (`ws.ts:279` `createWorkspace` already exists) but it is a *behaviour* change, not
a naming change. Fold it in, or land naming first against existing workspaces?
