# muxterm's session-first product model

**Status:** part implemented, part agreed, part open — every statement below is
marked individually. **Date:** 2026-09-25. **Source baseline:** `f8e03fd`
(origin/main, the merge of PR #209).
**Extends:** [Session-state protocol](session-state-protocol.md),
[Sessions report through hooks](designs/2026-09-22-agent-sessions-primary-design.md).

This is a **reference document, written down so the decisions survive**. They
were settled in a long design conversation that exists only in a chat session.
Where a rule has a REASON attached, the reason is part of the rule: it is what
stops the rule being undone later by somebody who forgot why it was made.

---

## 0. How to read this document

Every statement carries exactly one marker.

| Marker | Means |
|---|---|
| **SETTLED** | Agreed and not to be revisited. Not in the code yet unless a separate line says so. |
| **IMPLEMENTED (PR #N)** | True in the code at the baseline commit, verified by reading it. |
| **DEFERRED** | Agreed to be wanted, deliberately not built yet. |
| **OPEN** | Genuinely undecided. Recorded as open. Do not resolve it by reading this document. |

A separate marker, **Found in code**, records what verification against the
baseline actually showed — including where it disagrees with the decision above
it. Section 10 collects every disagreement in one place.

---

## 1. The object model

**SETTLED. The PROJECT is the unit of containment.** Not the workspace, not the
machine, not the terminal.

**SETTLED. Workspaces are DEMOTED.** They lose their identity role. They
survive, if at all, as a saved layout arrangement inside a project. Deletion is
the likely end state once layout moves client-side.

**SETTLED. Terminals are no longer the focus; sessions are.**

**SETTLED. MACHINE IS NOT INFORMATION ARCHITECTURE.** It is an ATTRIBUTE of a
session saying where it runs. **REASON:** containment that nests under a machine
stops a project spanning machines, which is the whole point of projects.

**SETTLED. Migration: existing workspaces become projects one-to-one at
upgrade.**

> **Found in code:** `SessionState` carries no `Machine` field
> (`internal/sessiond/sessionstate.go`). `machine` is added at the MCP
> projection (`internal/mcp/fleet.go:300`). Machine-as-session-attribute is not
> yet true on the wire row.
>
> **Found in code — naming hazard:** `SessionState.Project` already exists and
> means the session's **working directory**, an absolute path
> (`sessionstate.go:189`). `SessionState.ProjectID` means the **container**
> (`sessionstate.go:170`). Two meanings of "project" on the same row. Anything
> built on this model has to disambiguate them.

### 1.1 Layout

**SETTLED. Layout belongs to the DESKTOP CLIENT, locally — not the server.**
**REASON:** it differs per device and should not sync.

> **Found in code — this is a REVERSAL, not a continuation.** Layout is
> server-owned today: protocol verb `save-layout`
> (`internal/sessiond/protocol.go:35`), `Registry.SaveLayout(wsID, breakpoint,
> layout)` (`registry.go:384`), and `WorkspaceSnapshot.Layout map[string]string`
> — "verbatim copy of Registry's per-workspace Layouts map"
> (`snapshot.go:62`) — persisted in durable snapshots and restored with pane-id
> remapping (`snapshot.go:608-634`). It is keyed by breakpoint, which is a
> partial nod to per-device, but it is still stored on the server and therefore
> shared by every client. Meanwhile the client-side engine has already been
> deleted: `web/src/lib/arrangement-store.ts:3-7` records that `arrange()` and
> `ArrangementStore` "were removed under YAGNI" as "superseded by dockview's own
> panel management". Moving layout to the client means rebuilding something that
> was removed, and retiring a durable server field.

### 1.2 Dockview and applets

**SETTLED. Dockview hosts SESSION VIEWS AND NOTHING ELSE, ever.** Applets live
in their own right-hand region. **This is settled and not to be revisited.**

> **Found in code — consistent today.** `web/src/components/mux-dock.ts` binds
> dockview panels to `terminalRegistry` only; no applet ever enters it.
> `<mux-applets>` is mounted as Mission Control's right column
> (`web/src/components/mux-cos.ts:5`, `:1987`). The rule matches what ships; it
> is written down here so it stays that way.

---

## 2. The Inbox

**IMPLEMENTED (PR #209).** Merged as "Project model, slice 1: one fixed
container called Inbox that every session belongs to".

**IMPLEMENTED (PR #209). Exactly one reserved container, with a fixed reserved
id.** `InboxProjectID = "inbox"`, a package constant
(`internal/sessiond/project.go`). Reserved-ness is **computed from the id**
(`ProjectID.Reserved()`), never stored as a field. **REASON:** a stored flag
could be set to false on a value still carrying the Inbox's id — by a decoder,
by a struct literal, by a future refactor — and the invariant would evaporate
exactly where it matters.

**IMPLEMENTED (PR #209). CANNOT be deleted. CANNOT be renamed.**
`ProjectRegistry.Delete` and `.Rename` both return `ErrProjectReserved` for any
reserved id.

**IMPLEMENTED (PR #209). No settings, no context, no folder, no lifecycle — a
slot, not an entity.** `Project` carries id, name, and a derived `reserved` flag.
Nothing else.

**IMPLEMENTED (PR #209). Every session is created in the Inbox. `project_id` is
NON-NULL AT CREATION, never assigned afterwards.**
`SessionState.MarshalJSON` normalizes an unset parent to the Inbox
(`sessionstate.go:310-330`), so `"projectId": null` is not unlikely — it is
**unserializable**.

**SETTLED. UNASSIGNED IS A CONTAINER, NEVER A STATE.** There is no null case, no
`WHERE project_id IS NULL`, and no orphan is representable. **REASON:** that is
the entire point — same appearance on screen, much smaller data model.

**IMPLEMENTED (PR #209). This holds for sessions created with NO HUMAN
PRESENT** — triggers firing on a schedule, watch triggers, and agent
`spawn_lane` calls. Unattended creation has the same destination as attended.
The read path `stampProjectIDs` (`server.go:1807`) is total and runs over every
row every tick, regardless of origin.

**IMPLEMENTED (PR #209). Filing is a SEPARATE, LATER, HUMAN ACT. Creation never
files.**

**IMPLEMENTED (PR #209). There is no "unfile" verb.** Moving a session out of a
project IS moving it into the Inbox — one verb both directions
(`projectAssignments.Assign`, which deletes the record when the destination is
the Inbox). **REASON:** two verbs could disagree about what an unfiled session
is.

**IMPLEMENTED (PR #209). Nothing nags.** Unfiled is a valid resting state, not a
task. No badge, no counter of the unfiled, no warning colour, no call to action.

**SETTLED. When project creation arrives, it MUST NOT create a session directly
into a new project.** Creating a project and placing sessions in it remain TWO
OPERATIONS.

**SETTLED. Project deletion MOVES its sessions to the Inbox; it never deletes
them.** **REASON:** that is what makes deletion safe.

### 2.1 Naming

**IMPLEMENTED (PR #209).** The container is "Inbox" — not "Unfiled", not
"Uncategorized". **REASON:** those name an absence; this names a place.

**IMPLEMENTED (PR #209).** Containers with no sessions are still rendered.
**REASON:** a container that vanishes when it empties is a container you cannot
file into.

---

## 3. Settings

**SETTLED. Settings are GLOBAL.** There is no project-level settings UI and a
project owns NO configuration state — no model, no approval policy, no context,
no folder defaults.

**SETTLED. Per-project preference, where genuinely needed, is expressed in
`AGENTS.md` in the repository**, which the harness already reads. This is not a
muxterm feature and gets no muxterm storage, sync or UI.

**SETTLED. muxterm may READ `AGENTS.md` to show what is in effect; it must NEVER
WRITE to it.**

**SETTLED. SETTINGS ARE NOT AN APPLET.** Every applet is a view over content;
settings are application configuration. **Mockups showing settings-as-applet are
a known mistake and are superseded by this spec.**

**SETTLED — rule of thumb.** Repo files carry facts about the repo; global
settings carry preferences about the user. If something cannot be stated as a
fact about the repository, it does not belong in `AGENTS.md`.

**OPEN: whether `ADVICE.md` should ever exist.** Current answer is no — nothing
reads it by default, so muxterm would have to inject it, re-acquiring the
responsibility that delegating to `AGENTS.md` sheds. Recorded as open; not
resolved here.

> **Found in code:** no settings applet exists. `AppletId` is a closed union of
> `'dashboard' | 'files' | 'prs' | 'artifact'`
> (`web/src/lib/applet-registry.ts:58`). The mockup is ahead of the code, and is
> the thing being superseded — see §10.4.

---

## 4. Archiving, not deletion

**SETTLED. muxterm MUST NOT delete a session as a user-facing action.**
Archiving is the only removal gesture.

**SETTLED. Archiving removes from VIEW, never from storage.** An archived
session stays renderable and openable. Reversible in ONE action.

**SETTLED. Archived sessions KEEP their container.** Archiving is not a move to
a hidden container.

**SETTLED. `archived` is a field on session state carried in the SESSIOND
PROTOCOL and persisted in DURABLE storage — NOT a client-side view preference.**
**REASON:** the spool is rebuilt from producers every second, and anything not
in the protocol is gone on the next tick.

**DEFERRED. The existing `finished_clear.go`, `completion_clear.go` and
`hookreport_clear.go` paths are DELETES today; under this spec they become
ARCHIVE-SETTERS** — same gesture, nothing destroyed.

**SETTLED — design.** An archive entry is a **DURABLE INDEX RECORD, NOT A
COPY**: session id, name, harness, container, timestamps, and the path to the
harness's own transcript. **REASON:** harness transcripts are already durable on
disk; muxterm never becomes a transcript store.

**SETTLED — caveat.** A harness can prune its transcript, so an entry can
dangle. It must then read **"record exists, content unavailable"** — never
vanish, and never render an empty conversation as if that is what happened.

**SETTLED — scope-outs.** No hard delete. No "empty archive" action. No
retention timer that quietly removes things.

> **Found in code — an `archived` flag already exists, in a different place.**
> `TranscriptJournal.Archived` (`internal/mcp/journal.go:27`), set through
> protocol verb `session-archive` → `mcp.SetTranscriptArchived`
> (`internal/server/ws.go:698-702`), persisted durably via `atomicfile.Write`
> under `HookReportRoot()/journals/`. `SessionState` has **no** `Archived`
> field. So the gesture is half-built, on the transcript journal rather than on
> session state. ws.go's own comment calls it "journal metadata, not a daemon
> operation".
>
> **Found in code — "muxterm never becomes a transcript store" is already
> false.** `TranscriptJournal` is documented as "muxterm's durable, bounded
> projection of a native transcript. Native files remain authoritative for
> import; browser replay is served from this journal and therefore survives
> native-file removal" (`journal.go:16-18`). It stores `Turns`. It is a bounded
> **copy**, not an index — and it already solves the dangling-transcript caveat
> by not depending on the native file. The index-not-a-copy rule and the shipped
> journal have to be reconciled; this spec records the rule as stated and the
> code as found.
>
> **Found in code — `finished_clear.go` is an UNDOABLE delete.** It has a
> 10-second undo window (`finishedClearUndoWindow`) that restores the completion
> records, the spool snapshot and the hook registry entry **together**. And
> `projectAssignments.Forget` is deliberately NOT called from that path, so undo
> stays whole (`projectstore.go`, `Forget`'s doc comment). Converting the clear
> paths to archive-setters must preserve or consciously retire that undo.

---

## 5. Grouping suggestions (the learning layer)

**DEFERRED.** Nothing in this section is built.

**SETTLED — GOVERNING RULE. The suggestion layer may change WHAT THE USER SEES,
NEVER WHERE SOMETHING IS.** Presentation, not placement. **REASON:** this makes
it structurally incapable of hiding work.

**SETTLED — prohibitions.** It MUST NOT create, rename or delete projects. It
MUST NOT determine the container a new session is created in. It MUST NOT move a
session between containers.

**SETTLED — permissions.** It MAY cluster and reorder presentation of sessions
already in the Inbox, and offer a filing action the user confirms.

**SETTLED.** Enabled on install; produces nothing while fewer than two
containers exist.

**SETTLED.** Every suggestion MUST be explainable in ONE SENTENCE naming its
evidence.

### 5.1 Signals, in priority order

1. **SETTLED — CONTEXT:** folder, repo, harness, machine. Available immediately
   and explainable.
2. **SETTLED — USER CORRECTIONS:** each filing event is a labelled example and
   the only thing that trains anything. **A REJECTION is more informative than an
   acceptance and must be recorded with equal weight.**
3. **SETTLED — USAGE PATTERNS ARE EXPLICITLY NOT A SIGNAL.** **REASON:** they
   produce scores that cannot be explained.

### 5.2 Authority ladder

**SETTLED. AUTO-FILING IS EXCLUDED, NOT DEFERRED.** **REASON:** a wrong guess
does not lose a session, it HIDES one, which is worse.

**SETTLED.** What grows up the ladder is **how cheap consent becomes, never
whether consent happens**:

| Rung | Behaviour |
|---|---|
| 0 | No suggestions. |
| 1 | Shown on request. |
| 2 | Shown by default; Inbox presents clustered. |
| 3 | Destination pre-filled; filing is one gesture. |
| 4 | A cluster confirmable in one gesture. |

**SETTLED. THERE IS NO RUNG AT WHICH THE SYSTEM FILES WITHOUT A GESTURE.**

**SETTLED.** An explicit user preference overrides learned state
**UNCONDITIONALLY and PERMANENTLY** and is never re-learned away.

**SETTLED.** Learned state MUST be inspectable and resettable in one action.
**REASON:** a policy that cannot be seen or cleared is not user-authoritative
whatever its intent.

**SETTLED.** Promotion up the ladder must be REVERSIBLE and must NOT happen
silently.

### 5.3 Placement of the logic

**SETTLED.** The suggestion SOURCE is pluggable — heuristic, small local model,
or hosted model are implementation choices; the rules are identical for all.

**SETTLED. The ranking logic lives APP-LEVEL, above all containers — NOT
per-container and NOT inside a project.** **REASON:** a suggestion must rank
across ALL containers and so cannot live inside any one of them.

**SETTLED.** The authority level is STORED state with a default from the moment
the layer exists, but needs NO settings surface at introduction. The control
SURFACES at the moment the system first wants to offer more — **introduced in
the act of asking permission, not in a settings page.**

---

## 6. Execution context

**DEFERRED — backlog.**

**SETTLED.** A new chat may choose where it executes — this machine, another
machine, or a hosted environment — at creation, like picking a model.

**SETTLED.** It is a **SESSION ATTRIBUTE carried in the protocol**. NOT a session
type (location is orthogonal to harness/kind). NOT a container mode (**REASON:**
that would stop a project spanning machines, which is the whole point of
projects).

**SETTLED — IDENTITY BOUNDARY.** A session's identity is its **UUID ALONE**.
Machine is a **ROUTE**, never an identifier. Switching preserves session id, full
history and container membership — it is a **MOVE, not a recreate** — and is
reversible, switching back being the same operation.

**SETTLED — RISK TO SETTLE.** The distributed address format
`session://<node>/<project-id>/<session-uuid>` is **ambiguous**. If `<node>` is
identity, sessions cannot move and history fragments. If it is a route,
everything works. **Same string, opposite architectures.**

**SETTLED.** The choice stays light, but **CONSEQUENCES MUST BE SURFACED AT THE
MOMENT OF CHOOSING** — a moved session sees a different filesystem, different
credentials, and a working folder that may not exist.

**SETTLED.** A session that CANNOT move must say WHY. Silent failure or silent
partial move is forbidden.

**OPEN: whether "cloud" means another machine the user owns over SSH (what
muxterm does today) or a hosted environment they do not administer.** The second
brings credentials, tenancy and egress questions and is much larger. Recorded as
open.

---

## 7. Automation and bridges

**DEFERRED — backlog.**

### 7.1 Scheduled automation

**IMPLEMENTED (pre-existing, no PR attributed here).** Scheduled automation
already exists as a separate layer: `triggerStore`, a scheduler, a fire log, and
self-disable after three consecutive failures — exposed **only through MCP tools,
with NO UI**.

> **Found in code:** `internal/sessiond/trigger*.go`.
> `triggerFailureDisableThreshold = 3` (`trigger.go:116`). Fire outcomes are
> `fired`, `skipped-overlap`, `skipped-cap`, `skipped-max-runs`, `error`,
> `disabled`, `orphaned` (`trigger.go:56-82`) — the settled list of four is a
> subset; the code records seven. MCP surface only: `create_trigger`,
> `list_triggers` (`internal/mcp/run.go:913`, `:978`); no scheduler UI exists in
> `web/src/`.

**SETTLED. The backlog item is SURFACING AN EXISTING ENGINE, not building one.**

**SETTLED — RULE. THE UI IS A CLIENT OF THE JOB SYSTEM, NEVER ITS OWNER.** No
scheduling capability may exist only through the interface.

**SETTLED. DO NOT generalise triggers into an arbitrary job runner.** **REASON:**
a trigger's action being exactly `spawn_lane` is what makes overlap-skip, the
concurrency cap and self-disable possible at all; a generic runner loses every
one of those.

> **Found in code:** `trigger.go:149` — "Precisely spawn_lane's arguments,
> because the action IS spawn_lane."

**SETTLED. The genuine gap is VERBS, not generality:** triggers can only START
work, never steer a session already running.

### 7.2 Bot bridges

**SETTLED.** Bot bridges (Teams/Discord/Mattermost) belong in a **SEPARATE
INTEGRATION LAYER**.

- **Not the session layer** — **REASON:** sessions would have to know what
  Discord is.
- **Not transport** — **REASON:** transport moves frames; a bridge does identity
  mapping, thread-to-session correspondence, formatting and rate limits.

**SETTLED — RULE.** The integration layer is a **CLIENT OF THE SAME SESSION API
THE UI USES, WITH NO PRIVILEGED PATH.**

**SETTLED — TWO PREREQUISITES:**

1. **Acknowledged delivery into a session** — currently broken. See §10.2.
2. **MULTI-USER IDENTITY, which muxterm does not have.** There is one
   authenticated user today. A bridge means several humans addressing one fleet,
   raising who may steer which lane, whose approval counts, and whose name is on
   a turn. **This is the larger prerequisite and constrains the design rather
   than following from it.**

---

## 8. What PR #209 actually shipped

**IMPLEMENTED (PR #209), verified against `f8e03fd`.**

| Claim | Verified |
|---|---|
| `InboxProjectID` is a package constant; registry built in memory at boot | Yes — `project.go`, `NewProjectRegistry` |
| `Rename` and `Delete` already refuse reserved ids | Yes — both return `ErrProjectReserved` |
| `ResolveProjectID` is total; no input yields an empty id | Yes — `project.go` |
| `project_id` non-null on the wire | Yes — `SessionState.MarshalJSON`, `sessionstate.go:310` |
| Durable sidecar, absence of a record means Inbox | Yes — `projectstore.go`, `projectAssignments` |
| `ReassignAll(from, to)` written, no caller yet | Yes — `projectstore.go` |
| Protocol verbs `assign-session` / `list-projects` exist | Yes — `protocol.go:186-189`, plus their replies |
| No `Create` method exists | Yes — absent from `ProjectRegistry` |

### 8.1 What a future project-creation feature must add

**DEFERRED.** Taken from PR #209's own report and re-verified:

- `ProjectRegistry.Create(name)`, minting a non-reserved id.
- **A durable file for the registry itself.** It is in-memory today because its
  one member is a constant; a created project needs persistence.
- Protocol verbs for create/rename/delete, alongside the existing
  `assign-session` / `list-projects`.
- A `ReassignAll(from, InboxProjectID)` call in `Delete`.

**It does not have to touch** `SessionState`, the session schema, the spool, the
assignment store's schema, the stamping seam, or the sidebar's row rendering.
**REASON:** moving a session to a real project is CHANGING A PARENT — one value
in one map — not a schema migration. That is the whole reason `project_id` is
non-null from the first commit.

> **Found in code — scope correction.** That "does not have to touch" list
> describes the **future** feature. PR #209 itself **did** modify
> `internal/sessiond/sessionstate.go` and `internal/sessiond/sessionstore.go`,
> among 18 files. Both readings appear in circulation; the future-feature one is
> the correct one.

---

## 9. The spool, and why it constrains everything above

**IMPLEMENTED (pre-existing).** A session is **NOT a database row**. It is a
JSON snapshot written by an external producer into
`$XDG_RUNTIME_DIR/muxterm/session-state/`, re-read every second, with the daemon
**DELETING** files it will not publish. Reclaimed, never retained.

> **Found in code:** `sessionStateTick = 1 * time.Second`
> (`internal/sessiond/server.go:1670`); `os.Remove(path)` at
> `sessionstore.go:325`, `:358`, `:379`, `:422`.

**SETTLED.** Anything durable therefore cannot live in the snapshot: the producer
knows nothing about containment, and the daemon reclaims the file.

**IMPLEMENTED (PR #209) — the escape, already proven.** A daemon-owned sidecar
keyed by session id, **stamped onto the row on the way out**, exactly as
`PaneID`, `WorkspaceID`, `GoalID` and `Origin` already are (`stampPane`,
`sessionstore.go:540`; `stampProjectIDs`, `server.go:1807`).

---

## 10. Known blockers and inconsistencies

Recorded honestly. Each is verified against `f8e03fd`.

### 10.1 The spool is ephemeral — but it blocked two requirements, not three

**Partly resolved.** The decision as stated was that the ephemeral spool blocked
three things at once: durable `project_id`, the archive flag, and signal
recording.

> **Found in code — durable `project_id` was NOT blocked; it SHIPPED.** PR #209
> side-stepped the spool entirely with the sidecar-plus-stamp pattern of §9. Of
> the three, **the archive flag and signal recording remain blocked** — and both
> now have a proven escape route rather than an unknown one.

**Found in code — the durable pattern is two patterns, not one.** The decision
named "`triggerStore` and `internal/atomicfile`" as a single existing pattern.
They are different:

- `triggerStore.persistLocked` (`trigger.go:397-406`) and
  `projectAssignments.persistLocked` (`projectstore.go`) **hand-roll**
  `os.WriteFile` to a `.tmp` then `os.Rename`.
- `internal/atomicfile.Write` is a separate package, used by `hookreport.go:511`,
  `identity.go:77`, `mcp/journal.go:127`, `mcp/managed_turn.go:149`,
  `server/cos_attachments.go:544`, `sshconfig/write.go:94`.

Either is durable. A future implementer should know they are choosing between
two, not following one.

### 10.2 `session_send` fails against amplifier lanes

**BLOCKER — OPEN.** Reported symptom:

```
managed dispatch outcome is uncertain; prompt was not retried:
amplifier exited: exit status 1
```

Two attempts, both confirmed unadmitted by reading the lane's own transcript.
**The bot bridge (§7.2) depends on exactly this capability.**

> **Found in code:** the message is composed at
> `cmd/muxterm/session_send_cmd.go:82-83` — `cmd.Run()` fails, the managed turn
> is marked `"uncertain"`, and the prompt is deliberately never retried
> (**REASON:** native acceptance may have happened before the failure). The
> failure path is verified to exist and to behave as described. The
> amplifier-specific exit was **not re-run for this document**: reproducing it
> means injecting a turn into a live session.

### 10.3 PR #196 shipped machine grouping in the sidebar

**BLOCKER — OUTSTANDING REMOVAL.** It contradicts §1's rule that machine is not
information architecture.

> **Found in code:** PR #196, "Match the approved round-seven sidebar", merged
> 2026-09-24. `web/src/components/mux-sidebar.ts:175` states the sidebar "is the
> ONE surface that groups by machine (ux D1). EVERY reachable machine…". The
> grouping is live. PR #209 added the Inbox **above** the machine tree without
> touching it (`mux-sidebar.ts:2786-2789`: "This is added alongside, not
> instead of"), so both models are on screen at once today.

### 10.4 The UI mockups show settings-as-an-applet

**SUPERSEDED by §3.**

> **Found on disk** (in an uncommitted local artifact directory,
> `/home/ken/artifacts/workspace-ui-mockup/` — named here because it is the
> subject of this entry, not as reviewable evidence): `build_h.py:186` wraps
> `Settings · Appearance` in `<div class="applet">` with an applet provenance
> bar (`prov_bar("S", "Settings", …)`), and `:253` renders a `d-app` unit-dock
> button labelled "Settings" — settings as an atomic unit alongside terminal and
> chat. Confirmed as described. `README-v3.md` variant `h` is the affected pair
> of images. Should that directory be gone, the superseding rule in §3 stands on
> its own.

### 10.5 Signal recording was specified but NOT implemented

**BLOCKER — DEFERRED.** Filing events, session context at creation, repeated
sort, and rejections were specified in §5.1 but have nowhere durable to be
written until §10.1 is solved for them.

> **Found in code:** no signal, correction, or rejection record exists anywhere
> in `internal/sessiond/` or `web/src/`. `projectAssignments` stores the
> **outcome** of a filing (session id → project id) and not the **event**, so
> nothing today is a labelled example.

---

## 11. Summary of what is open

Listed here so no reader has to infer it.

| # | Open question | Section |
|---|---|---|
| 1 | Whether `ADVICE.md` should ever exist. Current answer: no. | §3 |
| 2 | Whether "cloud" means another machine the user owns over SSH, or a hosted environment they do not administer. | §6 |
| 3 | Whether `<node>` in `session://<node>/<project-id>/<session-uuid>` is identity or route. Same string, opposite architectures. | §6 |

Unresolved tensions between a settled decision and shipped code — the archive
index-vs-copy question (§4), server-owned layout (§1.1), and the machine grouping
still in the sidebar (§10.3) — are recorded where they arise. They are **not**
listed as open questions, because the decision is settled and the code is what
has to move.
