# Voice flow feedback for Amplifier Unified

Reviewed October 12, 2026. Focus: interaction flow, conversation ownership, task handoff, and recovery—not frameworks, transports, or provider selection.

## Evidence and scope

- Amplifier Unified: fresh source checkout at `/home/ken/workspace/amplifier-unified`, synchronized with `origin/main`, commit `af1d453c83288d0163bc40400b6a00120f3c26c0`. Installed Unified runtime and managed source copies were not updated or modified.
- muxterm: `main` at `0b804e43`, with a separate uncommitted composer-clear fix. The analysis below concerns the current SDK-chat voice implementation, not the retired COS implementation.
- ChatGPT and Claude: official documentation retrieved October 12, 2026, listed under External references.
- Repository conclusions are source-derived. No live microphone/provider session was exercised for this analysis. Product documentation describes supported flows, not a recording of a tested session on this account.

## Main recommendation

Make voice a way to interact with an established conversation, rather than requiring users to understand a second conversation with a second execution identity. Where a voice front end delegates to another agent, preserve the conversational continuity while making the handoff, target, progress, and completion honest and visible.

There are three different promises that should not share an ambiguous label:

1. **Dictate a message:** speech fills an editable prompt; sending is a separate action unless the user deliberately enables automatic submission.
2. **Have a voice conversation:** the assistant listens and speaks, answers conversational questions, and yields when interrupted.
3. **Coordinate work by voice:** the conversation can start, inspect, steer, or explicitly cancel work without requiring the user to leave voice.

Two-way speech does not itself prove task coordination. Automatic submission does not itself make dictation a two-way conversation.

## Roles and ownership

| Role | Owns | Must not be confused with |
| --- | --- | --- |
| Chat session | Durable conversational identity, written history, selected execution context, and attributable requests/results | A microphone connection or temporary provider session |
| Live voice session | The active listening/speaking interaction and its connection state | A new durable chat, or a running coding task |
| Realtime conversational model | Low-latency discussion, clarification, concise narration, recognizing when task work should be handed off | Proof that a code change happened, or a replacement execution harness |
| Root execution agent | Interpreting actionable instructions, running tools, observing permissions, maintaining task state, reporting grounded outcomes | The model alone or the speech interface |
| Code harness | The execution/session machinery around an agent: tools, permission handling, resume, steering and interruption semantics | A model, or a guarantee that an admitted instruction has executed |
| Execution model | Reasoning used by the root/task agent; selected independently from the speech model where the product has that split | A separate user conversation solely because it is a different model |
| Delegated agent / linked lane | A bounded assignment, its own work state and attributable result; possibly a separate durable session | The owner of the parent conversation or an implicitly selected voice destination |
| Application | Resolving the target, enforcing permissions, recording admission/results and coordinating lifecycle | A conversational model's unsupported assertion of success |

These are conceptual responsibilities, not a prescription for the number of processes or models. Claude Code dictation need not have a separate conversational realtime model. ChatGPT product docs establish user-facing voice/task roles, not its private harness internals.

### Recommended work loop

```text
Existing chat → activate voice → continue the conversation
                               ├─ discuss / clarify → spoken reply
                               ├─ check progress → grounded task state
                               └─ request work → explicit target + admission receipt
                                                   → execution agent / harness
                                                   → progress, blocker, result
                                                   → concise voice summary + written detail

Speak over a reply → stop/yield speech, not automatically cancel work
Say “stop the task” → explicit task cancellation request → confirmation/state
End voice → end listening/speaking; preserve the chat and independent work
```

This is a recommended flow contract, not a claim that every compared product implements every branch.

## Reference product flows

### ChatGPT: conversational voice and task coordination

Official desktop documentation describes GPT-Live as a conversational interface across Chat, Work and Codex. Users can enter voice in a supported existing task, preserve its conversation and execution-model selection, or start a new voice chat. While work runs they can check progress or change direction. Voice can also coordinate separate tasks and bring blockers/results back; switching the spoken destination is an explicit action. Availability is rollout-dependent. [E1]

General ChatGPT voice documentation separately establishes conversational interruption, spoken/text replies and chat-history transcripts. Dictation instead produces prompt text for review before sending. Do not infer that all ChatGPT voice surfaces have identical task capabilities. [E2]

**Lesson:** preserve conversation continuity and let work continue while the user talks. Surface explicit target changes rather than silently moving the conversation. Documentation does not establish precisely what ending voice does to every task; independent task lifetime is our recommendation, not an asserted universal ChatGPT behavior.

### Claude Code: voice input to the existing execution session

The specific Claude Code guide calls this **voice dictation**. `/voice hold` records while a key is held and inserts text at the cursor; by default the user presses Enter to submit. An optional hold auto-submit setting and tap-to-record/send mode submit transcripts of at least three words. Hold dictation can target a focused background-session reply in agent view. Canceling capture restores the prior prompt without also interrupting the agent on that keypress. [E3]

**Lesson:** keep the destination and submission boundary clear. Voice capture is not task execution, and canceling a recording is not task cancellation. Do not claim a separate realtime conversation model or spoken result loop for this documented Claude Code flow.

### Claude conversational voice: a separate comparator

Claude's consumer voice guide describes two-way speech, context continuity between text and voice, hands-free or push-to-talk interaction, spoken interruption and saved transcripts. It distinguishes that experience from Code/Cowork dictation. A broader power-user page uses “voice mode” for Code voice input; the feature-specific dictation guide is the more precise source for Code semantics. [E4, E5]

**Lesson:** compare actual interaction contracts, not the shared marketing label “voice.”

## muxterm: current flow and its own shortcomings

1. An SDK chat owns the durable event timeline. Activating voice creates a temporary live interface bound to that chat; recent chat exchanges seed its context. Voice history is also provided as bounded quoted context to subsequent task instructions. This is continuity, not a promise of an unlimited shared model context. [M1, M2]
2. The empty composer action starts voice. Connection requests microphone access, then presents Connecting, Listening or Speaking and a readiness cue. Active voice replaces the text composer. Escape or Stop voice ends capture/playback without calling the task-interrupt path. Changing/disconnecting the chat component stops its local voice connection. [M3, M4]
3. The voice interface is instructed to discuss concisely, answer status from supplied state, and delegate actionable work/corrections/explicit cancellation. The application sends a normal input or a steering input to the same root chat according to task state, retaining its execution model/effort. It distinguishes accepted, queued and unconfirmed delivery. [M5]
4. Task-tool activity and completion feed the voice interface. Completion adds a brief announcement and result excerpt; the full written result stays in the chat. Voice and task text have distinct attribution. Delegated-agent steering goes through the root chat, not directly to whichever agent card is open. [M6, M7]

**Do not present muxterm as a perfect reference:** current code hides the voice-start action while ordinary task work is busy, and hides the text textarea while voice is active. There is no current SDK-composer “type instead” affordance that leaves the call running. This prevents entering voice midway through text-started work through the normal button, and prevents locally typing an exact path/code snippet during a call. The backend has capabilities beyond what that UI exposes. [M3]

The older September Operator/COS contract describes a different continuity/typing experience and points to files removed from current `main`. It remains useful design history, but is not evidence for the current implementation. Do not give Unified's author an inaccurate “muxterm already does this” comparison. [M8]

## Amplifier Unified: current flow

1. Starting a call ensures a saved conversation and binds the call to its main Amplifier session. The voice model can acknowledge/clarify; reasoning, status questions, app actions and work are delegated to that main session through one capability boundary. The configured bundle—not the voice interface—decides whether to create workers. [U1]
2. Dictation is separate and draft-only. Live call speech goes directly into the conversation/handoff flow rather than an editable review stage. Model-mediated delegation, not every transcript fragment, triggers work. A visible transcript is not an execution receipt. [U2]
3. The composer remains available during a call. Typed content takes Send priority; the call strip exposes mute, end-call and a separate stop-work action. Ending audio leaves admitted work running. Speech interruption does not directly call work cancellation. [U3]
4. Calls stay bound to their originating conversation while the user browses other views/chats. The stop-work control targets the call owner, but typing targets the selected chat. Passive view/worker references update without changing where raw voice requests are sent. Opening a worker is not the same as speaking directly to it. [U4]
5. Delegation results wait for a matching finished manager generation/input identity, not an intermediate assistant message. Results include active worker identities, and narration warns if workers remain. Later results may be announced during the call. A completed manager response is not equivalent to all delegated work finishing. [U5]
6. Connection loss ends local media and offers recovery by starting another call; no automatic media reconnect loop was found. Saved history survives, but a new voice context is bounded: its initial recent-message selection excludes call-origin messages, while later execution handoffs include recent spoken reference context. Equivalent recall of spoken-only discussion after re-entry needs a real-call check. [U6]

**Unified is already ahead of current muxterm UI in important respects:** concurrent typing, separate mute/end/stop-work controls, call persistence during internal navigation, and explicit manager-versus-worker result correlation. Feedback should preserve these choices rather than propose rebuilding them.

## Difference matrix: flow, not stack

| Flow question | Amplifier Unified, current source | muxterm, current source | Useful product reference / feedback |
| --- | --- | --- | --- |
| Who owns work? | Saved main Amplifier session; voice has one delegation boundary; workers are bundle-owned | Existing root SDK chat; voice forwards work/steering with its selected execution model | Preserve one execution authority; different models need not mean different conversations |
| Who handles a status question? | Voice delegates to the main session for reasoning/current state | Application can answer a recognized status request from supplied task activity | Neither approach is inherently better: prioritize grounded freshness and a conversational response while work continues |
| Can I enter voice during work? | Empty composer offers Stop during an active response; background work alone is not the same gate | Busy root task replaces voice-start with task-stop | ChatGPT documents entry in supported existing tasks. Keep voice discoverable during execution [E1] |
| Can I type during a call? | Yes; text/attachments have Send priority | No current live-call textarea or type-instead control | Unified should keep this advantage; muxterm should improve its own flow |
| Does navigation retarget voice? | No; call remains pinned, but selected chat may become text destination | Changing chat tears down the component's local call | ChatGPT task switching is explicit. Unified should visibly label the pinned call owner [E1] |
| Does highlighting a worker mean I am speaking to it? | No; passive reference only; main session must route downstream | No; inspected delegated-agent steering explicitly goes through root | Label “ask root about this worker” versus direct task conversation; do not conflate them |
| Does interrupting speech stop work? | No direct cancellation from speech events; explicit Stop work exists | Voice instruction separates speech interruption from explicit cancel; task-interrupt route is separate | Preserve this separation. Live-provider interruption effectiveness still needs observation |
| Does ending voice stop work? | No; admitted work remains alive | Local voice stop does not call task interrupt | End call, cancel recording and stop task must remain distinct intents |
| What proves a result? | Correlated manager generation plus remaining-worker metadata | Task turn completion triggers concise notice; accepted/queued handoff is separately acknowledged | Keep admission, delivery/application, manager response and whole-job completion distinct |
| Does restarting voice restore all context? | Bounded seed; initial call-message exclusion merits checking | Bounded recent mixed history; voice excerpts also passed to task agent | Shared session identity does not imply identical complete context for both models |
| Is speech reviewable before execution? | Separate dictation yes; call delegation no explicit review stage | Separate draft dictation API exists; live handoff is not draft review | Claude Code default hold dictation is review-before-send, with explicit opt-in auto-send modes [E3] |

## Priority feedback for the author

### 1. Make the call's destination unmistakable

Show **“Voice connected to: [conversation title]”** in the persistent strip. After chat navigation, also clarify **“Typed messages go to: [selected chat]”** when it differs. Offer an explicit return-to-owner or switch-call action; never silently retarget speech. The current strip's model/voice/status label is less informative than the implemented ownership semantics. This is a concrete current flow gap. [U4]

### 2. Preserve independent call and work controls

Keep the implemented mute/end-call/stop-work distinction and concurrent composer. Improve voice discoverability while an ordinary response is active. Show a short handoff state (“Queued for the main agent”, “Delivered”, “Awaiting permission”), then a separate grounded result; do not let a quick voice acknowledgement sound like completion. Verify the exact steering capability of the configured runtime rather than promising instant preemption. Much of the underlying identity correlation already exists. [U3, U5]

### 3. Keep late speech relevant to the latest intent

When a user corrects or cancels a worker, do not later announce an obsolete queued result as current. A manager turn can finish with workers active; name which response/task completed. Unified's own boundary document acknowledges per-worker invalidation of queued narration as a remaining gap. This is more actionable feedback than generically requesting “better progress.” [U5]

### 4. Verify continuity rather than infer it from a session ID

Test a spoken-only discussion, hang up, re-enter the same chat, and ask about it before requesting new work. The current initial context excludes call-origin messages. Decide what bounded voice/history summary is needed, and be explicit when older context is unavailable. Also verify that reconnecting after an admitted request inspects existing work rather than reissuing it. Existing durable identity and result correlation are strengths to preserve. [U6]

### 5. Name the interaction mode and target, not just the model

Explain “Dictate a message” versus “Start a voice conversation.” If the execution agent uses a different model, show it as a task setting, not as a new assistant the user must manually synchronize. State when the voice interface is clarifying, when the root agent is reasoning, and when a worker is executing. Screen/source labels or a highlighted worker are context references, not proof of observation or a changed destination. [U1, U4]

## Author-ready feedback

> Unified already has the right core split: the saved Amplifier session owns work, the voice interface owns spoken interaction, typing remains available, and hangup does not cancel work. Please preserve those choices. The biggest flow improvement is to make the voice destination visible: after navigating, the call still belongs to its original chat while typed input can go elsewhere. Label that explicitly. Also keep voice reachable during active work, distinguish admission and manager responses from completed worker jobs, suppress stale result narration after corrections, and verify spoken-only continuity across hangup/re-entry. ChatGPT is a useful reference for conversational task coordination; Claude Code is a useful reference for precise dictation and submission boundaries, not an equivalent two-way voice architecture. muxterm offers useful root-chat handoff and receipt semantics, but our current UI also blocks starting voice during busy work and typing during calls. These are shared improvement opportunities, not reasons to copy our UI literally.

## Recommended acceptance scenarios

These are suggested real-user verification scenarios, not executed tests or implementation requests.

1. Start with several text turns, enter voice, ask about a prior decision, end voice, reopen it, and continue without creating a replacement chat.
2. Start a long task by text; enter voice midway; ask for status without restarting that task. Show voice state and task state independently.
3. Ask a clarification in voice without intending work. Do not silently submit every utterance as a new coding task.
4. Request a change; show admission and the target. While it runs, steer it; distinguish queued instruction from applied change.
5. Speak over a long reply. Speech yields; work remains running unless the user explicitly requests cancellation. “Stop talking” and “stop the task” have distinguishable effects.
6. Type an exact filename while talking; preserve the draft, target and voice context. Ending voice does not send that draft.
7. Open another agent/lane or navigate to another chat. Show or end the existing voice binding deliberately; never silently reroute the next utterance based only on a view change.
8. Receive an approval request or error during voice. Show the authoritative permission/blocker; do not claim execution succeeded or bypass approval because the instruction was spoken.
9. Lose the voice connection after a request was admitted. Restore conversation continuity and inspect existing task state without re-submitting the request.
10. Get a result while discussing another topic. Deliver a brief attributed notice and a durable written result, without reading the entire tool output aloud or claiming queued work is finished.

## Source index

All muxterm references are relative to `/home/ken/workspace/muxterm` at the stated revision.

- M1: `internal/server/sdk_voice.go:53` — temporary voice connection versus durable chat; `internal/server/sdk_voice.go:102` — bounded same-chat history.
- M2: `internal/server/sdk_voice.go:198` — voice context carried into task requests; `internal/server/sdk_chat.go:1859` — typed follow-up context.
- M3: `web/src/components/mux-sdk-chat.ts:1865` — toggle guards; `web/src/components/mux-sdk-chat.ts:1877` — action priority; `web/src/components/mux-sdk-chat.ts:1932` — live composer replacement.
- M4: `web/src/lib/sdk-voice-session.ts:38` — activation; `web/src/lib/sdk-voice-session.ts:118` — stop; `web/src/components/mux-sdk-chat.ts:153` — Escape; `web/src/components/mux-sdk-chat.ts:645` — chat switching.
- M5: `internal/server/sdk_voice.go:268` — conversational contract; `internal/server/sdk_voice.go:479` — status/cancel/handoff; `internal/server/sdk_voice.go:527` — root model/effort and receipts.
- M6: `internal/server/sdk_voice.go:555` — task events to voice; `web/src/components/mux-sdk-chat.ts:1106` — voice timeline attribution.
- M7: `web/src/components/mux-sdk-chat.ts:1498` — delegated-agent steering through root; `docs/design/operator-chat.md:1` — linked-chat ownership/reporting design.
- M8: `docs/decisions/2026-09-15-operator-composer-and-voice-contract.md:1` — historical COS contract, not current SDK behavior.

All Unified references are relative to `/home/ken/workspace/amplifier-unified` at the stated revision. Detailed source-analysis notes are in `/home/ken/workspace/muxterm/tmp/unified-voice-flow-notes.md`.

- U1: `amplifier_web/voice.py:24` — delegated reasoning policy; `amplifier_web/voice.py:85` — single delegation capability; `amplifier_web/runtime_worker.py:870` — existing runtime input; `docs/voice-amplifier-boundary.md:3` — one execution owner.
- U2: `frontend/src/dictation-controls.jsx:13` — distinct draft dictation; `frontend/src/main.jsx:478` — call entry; `amplifier_web/voice.py:294` — voice delegation; `amplifier_web/service.py:4023` — authoritative transcript storage.
- U3: `frontend/src/composer.js:16` — content/call/response action priority; `frontend/src/work-shell.jsx:112` — call controls; `amplifier_web/voice.py:468` — call close leaves admitted work alive.
- U4: `amplifier_web/voice.py:92` — fixed session owner; `amplifier_web/voice.py:365` — passive context refresh; `frontend/src/work-shell.jsx:115` — call strip; `frontend/src/main.jsx:521` — pinned stop-work target; `frontend/src/main.jsx:538` — typed destination.
- U5: `amplifier_web/service.py:4043` — identified admission; `amplifier_web/service.py:4089` — correlated manager result; `amplifier_web/voice.py:398` — generation notices; `amplifier_web/voice.py:498` — remaining work in narration; `docs/voice-amplifier-boundary.md:16` — queued-narration caveat.
- U6: `amplifier_web/voice.py:59` — bounded context including non-call recent messages; `amplifier_web/voice.py:343` — spoken handoff context; `frontend/src/voice.js:91` — connection loss; `frontend/src/voice.js:152` — page lifetime; `docs/voice.md:30` — physical/live verification limits.

### External references

Retrieved October 12, 2026; product behavior and availability can change.

- E1: ChatGPT Learn, **ChatGPT Voice** — https://learn.chatgpt.com/docs/features/voice
- E2: OpenAI Help, **ChatGPT Voice** — https://help.openai.com/en/articles/20001274-chatgpt-voice
- E3: Claude Code Docs, **Voice dictation** — https://code.claude.com/docs/en/voice-dictation
- E4: Claude Help, **Use voice mode** — https://support.claude.com/en/articles/11101966-use-voice-mode
- E5: Claude Help, **Claude Code power user tips**, Voice input — https://support.claude.com/en/articles/14554000-claude-code-power-user-tips
