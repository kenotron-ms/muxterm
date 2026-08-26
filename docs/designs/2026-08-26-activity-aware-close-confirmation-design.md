# Activity-Aware Close Confirmation Design

## Outcome

Pane and workspace closure becomes server-authoritative and activity-aware. A target closes without a prompt only when every pane in scope is demonstrably idle at a supported interactive root-shell prompt. Any positive evidence of running work, or any inability to establish safety, produces one confirmation modal before destruction.

This replaces the five-second deferred-destruction and Undo experience. The target stays visible and live while authority or user confirmation is pending. All-idle targets close after only the daemon round trip, with no warning, modal flash, Undo toast, or local delay. The interaction may be cmux-like, but this design makes no claim of matching cmux's detector or exact behavior.

## Scope and Non-goals

In scope are pane and workspace close intents from every browser surface; daemon-owned tri-state activity classification; server-side workspace aggregation; correlated close outcomes and confirmation tickets; one accessible modal for both target kinds; and authoritative multi-client reconciliation.

The safety contract is prompt readiness, not absence of every descendant process. A background job that has returned control to a valid root-shell prompt does not block automatic closure. Non-terminal browser panes, custom-command panes, unsupported shells or platforms, and states with incomplete evidence remain closable only after confirmation.

This design does not infer safety from terminal text, titles, recent input, or browser-cached pane data. It does not expose raw process details, reconstruct cmux internals, promise exact cmux parity, add a replacement recovery mechanism for Undo, or broaden trusted shell and platform coverage by weakening the unknown state. Unit-test coverage is also outside the project contract; evidence comes from the integrated product.

## Evidence and Constraints

- Pane closure currently removes the browser panel first, retains the live PTY for five seconds, and then sends an unconditional destructive close. Undo cancels the timer and restores the panel without having touched the PTY.
- Workspace closure currently marks the workspace locally pending, waits five seconds, and then sends an unconditional destructive close. The new behavior must remove optimistic disappearance, pending-close timers, and Undo notifications from both paths.
- The session daemon owns each terminal's root process, root PID, PTY master, and lifecycle. Activity is not presently carried in pane metadata or the browser transport contract.
- Existing shell integration recognizes a command-completion or prompt signal, but it does not retain a complete prompt-active versus command-active lifecycle for the current root process generation.
- The daemon can inspect the PTY foreground process group and compare it with the root shell's process group. That detects most foreground child work but does not by itself detect shell builtins or functions.
- A browser pane has no PTY process. A custom-command pane is not known to host the supported interactive root shell. Neither can satisfy the idle proof.
- The browser has detailed pane state only for its attached workspace. Workspace assessment therefore belongs to the daemon and always names an explicit workspace identity.
- Transport evolution favors additive messages with request correlation. The close contract must preserve that pattern and must not require a safety query followed by an ordinary close on the idle path.
- New unit tests are prohibited. Evidence must use a real browser, a real session daemon, and fresh workspaces and panes for each pass, with the existing lint, type, and compile gates as supporting evidence.
- A local design reference supports studying cmux's user interaction, but provides no evidence of its internal detector. Only the interaction principle informs this design.

## Decisions

| ID | Decision | Rationale | Ranked alternatives |
|---|---|---|---|
| D-01 | Every pane and workspace close entry point emits a pre-removal close intent. The target remains visible, usable, and live until the daemon confirms closure. The prior five-second timers, optimistic pending state, Undo actions, and Undo toasts no longer participate in these close paths. | Prevents browser state from diverging from live daemon state and avoids hiding a PTY before safety is known. | 1. Pre-removal daemon intent; 2. retain deferred destruction and Undo; 3. remove first and restore after a warning. |
| D-02 | The session daemon is the sole safety authority. Each pane is classified as idle, busy, or unknown. The browser never classifies from text, titles, input timing, local metadata, or cached lifecycle state. | The daemon alone owns the root process and PTY evidence needed for a defensible answer, including panes outside the attached workspace. | 1. Daemon authority; 2. relay-layer inference; 3. browser inference. |
| D-03 | Use a conservative hybrid lifecycle-plus-foreground-process-group classifier. Idle requires a supported default interactive root shell, a valid prompt-active state tied to the current root process generation, a live root shell, and the root shell's process group owning the foreground PTY. Busy results from trusted command-active lifecycle state or a different process group owning the foreground PTY. Unknown covers missing or stale lifecycle state, custom-command panes, browser panes, unsupported shells or platforms, process or PTY inspection failures, and conflicting evidence. Busy and unknown both require confirmation. A background job at a valid returned prompt is idle by contract. | The hybrid catches external foreground work and shell-local builtins or functions while failing safely whenever the proof is incomplete. It aligns automatic closure with the requested prompt-readiness contract. | 1. Hybrid lifecycle and foreground ownership; 2. foreground ownership alone, which misses shell builtins and functions; 3. process-tree enumeration, which is platform-specific, noisy, and racy despite seeing background descendants; 4. terminal-text, title, or input heuristics, which are not authoritative. |
| D-04 | One correlated daemon close-intent transaction assesses the named target. It closes an idle pane or all-idle workspace in the same transaction and returns closed. If any pane is busy or unknown, it returns confirmation-required with risk reasons and an opaque ticket, without mutation. | Removes the time-of-check gap created by a separate query followed by an ordinary destructive request and preserves an immediate idle fast path. | 1. Combined assess-and-close transaction; 2. separate assessment and close requests; 3. browser assessment followed by unconditional close. |
| D-05 | A confirmation ticket binds target kind and stable identity, target generation, the assessment snapshot, and, for a workspace, its pane-membership generation. Confirmation may destroy only that warned snapshot. Identity or membership change invalidates the ticket and causes reassessment; newly added or otherwise unwarned panes are never silently terminated. An already-absent target reconciles as closed. | Protects against stale dialogs, identity reuse, and cross-client workspace changes while keeping the browser unable to forge or reinterpret authority. | 1. Opaque daemon-bound ticket; 2. browser-echoed snapshot without daemon binding; 3. unconditional confirmed close by identity. |
| D-06 | Workspace safety is aggregated entirely in the daemon from one consistent snapshot. All idle closes immediately. Any busy or unknown member produces exactly one workspace modal containing a bounded list of risky pane titles and high-level reason categories, with an omitted-count summary when necessary. | The browser cannot assess unattached workspaces, and one workspace decision is clearer and safer than serial pane dialogs. | 1. One daemon aggregate and one modal; 2. serial per-pane confirmations; 3. assessment from the attached browser subset. |
| D-07 | One reusable accessible modal serves both targets. Titles are “Close pane?” and “Close workspace?”. Busy copy states that running work will be terminated; unknown copy states that activity could not be determined and work may be terminated. Actions are Cancel and “Close Pane” or “Close Workspace”. Cancel receives initial focus; Escape and backdrop dismiss; Enter activates only the focused control and never implicitly selects destruction. The destructive action is visually distinct. The target remains live while a decision is pending, and duplicate intents focus the existing modal rather than stacking dialogs. | Gives a predictable safety interaction without making the destructive action the keyboard default or interrupting the underlying process before a decision. | 1. Shared target-aware modal; 2. separate pane and workspace dialogs; 3. generic browser confirmation; 4. destructive default action. |
| D-08 | Pane chrome, keyboard shortcuts, workspace sidebar, workspace picker, and mobile actions all use one browser close-intent coordinator. No browser control may send a direct destructive close. | A single policy boundary prevents individual interaction surfaces from bypassing classification or reintroducing optimistic removal. | 1. Unified coordinator; 2. duplicated handlers sharing conventions; 3. independent direct-close controls. |
| D-09 | Transport failures and timeouts leave the target visible and locally untouched with a recoverable error. Classification failures become unknown and therefore require confirmation. Cancel mutates nothing. Closure broadcasts dismiss stale modal state and remain authoritative for final reconciliation. Ticket invalidation refreshes the assessment or modal rather than closing. | Ambiguity must fail toward preserving the target, except when the daemon can explicitly classify the ambiguity as unknown and ask the user. | 1. Preserve and recover; 2. retry destructive closure automatically; 3. assume idle on failure. |
| D-10 | The all-idle path closes directly with no modal flash and no browser waiting period beyond the daemon round trip. | Prompt-ready shells should retain the speed of an ordinary close despite the stronger safety contract. | 1. Immediate server-authorized close; 2. always confirm; 3. retain a local grace timer. |

## Components and Boundaries

| Component | Owns | Does not own | Expected file or subsystem boundary |
|---|---|---|---|
| Session activity classifier | Root-shell identity, current process generation, prompt or command lifecycle, foreground PTY ownership, tri-state classification, and reason category | Close policy, workspace aggregation, tickets, transport, or UI | Session-daemon activity subsystem |
| Daemon close transaction coordinator | Pane and workspace assessment, idle fast-path closure, workspace aggregation, confirmation-ticket issuance and validation, and destructive authorization | Shell signal collection, warning presentation, or browser layout | Session-daemon lifecycle and close subsystem |
| Daemon workspace state | Stable target generations, pane-membership generation, authoritative membership, and closure events | Activity interpretation or modal state | Session-daemon workspace state subsystem |
| Transport contract and relay | Additive correlated close intents, outcomes, risk summaries, tickets, confirmations, and authoritative closure broadcasts | Activity inference, ticket policy, or presentation | Control transport boundary between browser and daemon |
| Browser close-intent coordinator | A single entry point for every UI source, pending request and modal state, recoverable errors, duplicate-intent coalescing, and confirmation forwarding | Terminal inspection, safety classification, destructive closure, or optimistic removal | Browser application coordination layer |
| Confirmation modal | Accessible presentation, target-specific labels and copy, focus behavior, dismissal, and destructive visual treatment | Classification, ticket interpretation, target mutation, or reconciliation | Browser presentation layer |
| Browser state reconciliation | Applying authoritative pane and workspace closure broadcasts and dismissing stale pending UI | Preemptive target removal, safety decisions, or daemon mutation | Browser state boundary |

## Interfaces and Flow

| Exchange | Carries | Semantics |
|---|---|---|
| Close intent | Request correlation, target kind, and stable target identity; a workspace intent always includes its explicit workspace identity | Starts the sole assess-and-close transaction. The browser performs no local removal or safety guess. |
| Closed | Correlation and target identity | The daemon accepted and completed the idle fast path. Authoritative closure broadcasts reconcile every client. |
| Confirmation-required | Correlation, opaque ticket, target identity, consistent assessment summary, and a bounded list of risky pane titles with reason categories | No server mutation occurred. Busy categories distinguish command-active and foreground work; unknown categories cover unsupported pane or shell, stale or missing lifecycle state, unavailable inspection, and conflicting evidence. Raw commands, PIDs, and process-group details are excluded. |
| Absent or already closed | Correlation and target identity | The request is idempotently reconciled as closed; stale browser state waits for or applies authoritative state. |
| Recoverable failure | Correlation, target identity, and user-safe failure category | The target remains locally present and live. The outcome does not grant destructive authority. |
| Confirm | Request correlation and the opaque ticket | The browser does not restate or modify the assessment. The daemon validates the bound identity and generations before destruction. |
| Cancel | Browser-local pending state only | No server message is required because assessment caused no mutation. |
| Closure broadcast | Authoritative pane or workspace lifecycle change | All clients converge on daemon state and clear matching pending requests, dialogs, and errors. |

For a pane intent, the daemon classifies the current pane generation. Idle closes inside the intent transaction. Busy or unknown returns one ticket and leaves the same PTY alive; Cancel merely dismisses the modal, while Confirm submits the opaque ticket for validation and closure.

For a workspace intent, the daemon resolves the explicit workspace identity, captures one membership generation, and classifies every member in that snapshot. All idle closes in the same transaction. Any risky member yields one aggregate modal. A valid confirmation closes only the bound workspace snapshot. A changed target identity or membership invalidates confirmation and returns a fresh assessment without destroying the changed target.

The requesting browser never treats its attached-workspace cache as closure authority. A closed response establishes the request outcome; daemon broadcasts remain the structural source of truth for removal and cross-client convergence.

## Failure Handling

| Condition | Required behavior |
|---|---|
| Intent timeout, relay failure, or disconnect | Keep the target visible and locally untouched, dismiss any request spinner, and surface a recoverable error. A later authoritative closure broadcast supersedes the error if the daemon had already accepted closure. |
| Missing, stale, unsupported, or failed activity evidence | Classify the affected pane as unknown and return confirmation-required rather than failing open or closing automatically. |
| Cancel, Escape, or backdrop dismissal | Clear only browser-local dialog state; preserve the same target, PTY, process, output, and layout. |
| Closure by another client | Apply the daemon broadcast, remove stale local target state, and dismiss any matching modal or recoverable error. |
| Ticket target-generation or workspace-membership mismatch | Reject destructive confirmation, reassess, and refresh or dismiss the modal according to the new assessment. The invalid confirmation itself never closes anything. |
| Duplicate intent for a target with an open modal | Focus the existing modal and retain its single ticket; do not create another dialog or destructive request. |
| Target already absent | Return or reconcile the absent outcome as closed without an error loop. |
| Reply lost after accepted closure | Preserve local state until the authoritative broadcast arrives; do not reconstruct closure from browser assumptions. |

## Verification Outcomes

| Outcome | Observable evidence | Acceptance signal |
|---|---|---|
| Supported default-shell pane at a valid prompt | Closing the pane produces no modal, delay, or Undo UI; the daemon closes it and every connected browser reconciles. | Direct closure occurs after the daemon round trip with no modal flash. |
| Foreground external command or TUI | A pane close intent leaves the process running and opens “Close pane?” with a running-work warning. | No target mutation occurs before confirmation. |
| Shell builtin or function marked command-active | The root shell still owns the foreground PTY, yet the lifecycle signal causes the pane modal to appear. | Hybrid classification catches work that foreground ownership alone misses. |
| Pane cancellation | Process identity, PTY continuity, accumulated output, and layout remain unchanged after Cancel, Escape, and backdrop dismissal. | No daemon mutation or browser reconstruction is observable. |
| Pane confirmation | “Close Pane” terminates the warned pane and authoritative broadcasts reconcile all connected browsers. | Only the ticket-bound pane generation closes. |
| All-idle workspace | Every member is a supported root shell at a valid prompt. Closing the workspace produces no modal or Undo UI. | The workspace closes in the daemon round trip and all clients converge. |
| Mixed idle, busy, and unknown workspace | Exactly one “Close workspace?” modal lists risky pane titles and applicable reason categories from one bounded snapshot. | No serial pane prompts appear, and omitted items are summarized without raw process data. |
| Workspace cancellation | All panes retain their PTYs, processes, output, and layout. | Cancel causes no server-side state change. |
| Valid workspace confirmation | “Close Workspace” closes the still-valid warned snapshot and all clients reconcile. | No pane outside the ticket-bound snapshot is terminated. |
| Unknown pane categories | Custom-command, browser, unsupported-shell, unsupported-platform, stale-integration, process-inspection-failure, and PTY-query-failure cases each require confirmation. | None can enter the automatic idle path. |
| Background job after a valid returned prompt | The lifecycle is prompt-active and the root shell owns the foreground PTY while a background descendant remains. | Closure proceeds without warning, matching the explicit prompt-readiness contract and its documented data-loss risk. |
| Modal accessibility and keyboard behavior | Cancel initially owns focus; Escape and backdrop dismiss; Enter follows the focused control; the destructive action is visually distinct. | No keyboard path implicitly selects destruction. |
| Multi-client stale closure | One client closes a target while another displays or awaits its modal. | The second client dismisses stale pending UI when the daemon broadcast arrives. |
| Workspace membership race | A new pane appears while a workspace modal is open, changing membership generation. | Confirmation is invalidated, nothing closes, and the displayed assessment is refreshed. |
| Duplicate close intents | Repeated close gestures target the same pane or workspace while its modal is open. | One modal and one ticket remain; the existing modal receives focus. |
| Request timeout or disconnect | The browser does not hide or mutate the target and presents a recoverable error. | Normal use can continue unless a later daemon broadcast authoritatively reports closure. |
| Already-absent target | A stale close intent names a target removed elsewhere. | The browser reconciles it as closed without repeated warnings or failures. |
| Verification hygiene and static quality | Each real browser and session-daemon pass uses a fresh workspace and pane; clean passes use a full daemon restart; lint, type, and compile gates remain clean. | Integrated evidence is repeatable without adding unit tests or reusing stale fixtures. |

## Assumptions and Risks

| ID | Assumption or risk | Consequence if false | Containment |
|---|---|---|---|
| R-01 | Supported default-shell integration can provide trustworthy prompt-active and command-active boundaries for the current root process generation. | A false idle signal could permit unprompted loss of active shell-local work. | Idle additionally requires a live root shell and matching foreground PTY ownership; missing, stale, or conflicting lifecycle evidence degrades to unknown. |
| R-02 | Foreground-process-group inspection is available and reliable on supported Unix targets. | External foreground work may not be distinguishable from a prompt by process ownership. | Unsupported platforms and every inspection error degrade to unknown and require confirmation. |
| R-03 | Prompt readiness is the intended safety contract even when background jobs still exist. | Background descendants can be terminated without a warning after control returns to the prompt. | Treat this as an explicit accepted data-loss trade-off, document it in verification evidence, and do not claim process-tree quiescence. |
| R-04 | OS and process transitions remain inherently racy, including commands started concurrently from another client. | Activity can change at the boundary between observation and termination. | The daemon combines assessment and idle closure in one transaction and binds confirmations to target and membership generations; this minimizes but cannot eliminate the race. |
| R-05 | Removing Undo is acceptable for targets proven idle. | An accidental close at an idle prompt has no five-second recovery path. | Confirmation protects active and unknown targets; the product deliberately preserves immediate direct close for demonstrably idle targets rather than adding another recovery mechanism. |
| R-06 | Browser and custom-command panes cannot provide the root-shell proof required for idle. | These panes always warn, potentially increasing confirmation frequency. | Keep the policy intentionally conservative, explain the unknown reason, and aggregate workspace warnings into one modal. |

## Shared Seams

| ID | Shared surface | Owning component | Consumers | Collision rule |
|---|---|---|---|---|
| S-01 | Activity classification contract | Session activity classifier | Daemon close transaction coordinator | Classification semantics change only at the classifier boundary; consumers use idle, busy, unknown, and reason categories without duplicating detection. |
| S-02 | Close-intent and confirmation-ticket protocol | Daemon close transaction coordinator | Transport relay and browser close-intent coordinator | Evolution remains additive and correlated; tickets stay opaque, and daemon validation prevails over browser state. |
| S-03 | Authoritative pane and workspace closure broadcasts | Daemon state | Transport relay and browser state reconciliation | Daemon lifecycle events win every conflict; browser components never remove targets optimistically. |
| S-04 | Shared confirmation modal surface | Browser presentation | Pane and workspace close intents | Presentation and accessibility behavior are centralized; target-specific title, copy, and action labels enter through the shared surface rather than separate dialogs. |
| S-05 | Unified close entry-point contract | Browser close-intent coordinator | Pane chrome, keyboard shortcut, workspace sidebar, workspace picker, and mobile actions | Every UI source funnels through the coordinator; no consumer retains a direct destructive path. |
| S-06 | Workspace pane-membership generation | Daemon workspace state | Confirmation-ticket issuance and validation | Only daemon workspace state advances and compares membership generation; browsers treat it as server authority and never synthesize it. |
