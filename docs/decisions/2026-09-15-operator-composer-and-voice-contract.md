# Voice Mode durability and Operator continuity

**Production base:** `v0.34.6` / `16f20502beffef2311038950af9371b3930d043f`
**Voice restoration commit:** `36a399496f30449ce83251aa56e88a0ad39fa863`
**Pre-App-Voice baseline:** `v0.32.0` / `4c5f897c7759f6776e95cada2f00aa36911ae9f2`
**Compared release:** `v0.34.5` / `8cfe4caecf2d1f3e6cd04937fb2b85d1e0b6e2be`

## Diagnosis

The reported provider text is a Realtime `response.create` admission conflict,
not a COS Supervisor/FIFO refusal:

1. A typed message follows `CosStore.send()` in
   `web/src/lib/cos-store.ts`, then `Client.cosTurn()` →
   `cosRelay.enqueue()` → `cosRelay.runAdmissions()` in
   `internal/server/cos.go`.
2. That path enters the single `internal/cos/queue.go` FIFO. It has no call to
   `VoiceMode` teardown, `Manager.End`, WebRTC close, or sideband close.
   A COS concurrency refusal would instead be the sidecar's `busy` event from
   `internal/cos/sidecar/main.py`, not a Realtime `resp_…` message.
3. While Voice Mode was live, the browser controller subscribed to COS events.
   A text turn's later `tool_start` or `approval_request` called `_say()` in
   `web/src/lib/voice-session-controller.ts`. `_say()` created a Realtime
   conversation item and a `response.create` from the browser.
4. The trusted sideband independently emits `response.create` after function
   output in `internal/voice/sideband.go`. Its old grace/timer and its
   browser-independent activity view could race the browser request or an
   audio-originated response.
5. If the provider returned
   `conversation_already_has_active_response`, the browser's generic
   `error` branch treated that recoverable admission state as fatal and called
   `_fail()`. `_fail()` invokes `_teardown()`, which closes WebRTC/audio and
   posts `/api/cos/voice/end`. This is why a text turn could appear to disable
   Voice Mode even though text admission itself did not own Voice lifecycle.

This is therefore a combination of **(a)** a provider Realtime response
admission conflict, **(c)** browser fatal classification, and **(d)**
independent browser/sideband response creation. It is **not (b)** a COS queue
rejection.

`v0.32.0` already contained the browser `_say()`/generic-error shape and did
not carry prior Operator history into a newly minted Realtime session. The
v0.34.6 restoration correctly restored its WebRTC lifetime and
provider-owned ordinary turn detection, but also restored that old response
admission weakness. Separately, current `mux-cos` inherited v0.34.5's
`!busy && !admissionPending && !draftPresent` condition around the inactive
Voice orb; that made the Voice control disappear while ordinary text work was
active, unlike the v0.32 composer. This hotfix restores availability without
restoring the post-v0.32 App Voice architecture.

## Three histories, one authoritative conversation

There is no persistent provider Voice Mode transcript:

| History | Owner and lifetime | Current behavior |
| --- | --- | --- |
| Realtime provider conversation | One freshly minted provider session per Voice activation | `Client.MintEphemeral()` in `internal/voice/client.go` sends only fixed instructions/tools; `Manager.Connect()` establishes one WebRTC call and sideband. Voice end closes muxterm's handle; reactivation mints a new provider session. |
| Operator/COS transcript | One persistent server-owned Amplifier session | `cosRelay.configureRoot()` selects/locks it; `internal/cos/sidecar/main.py` restores, executes, and persists it. `Supervisor.History()` returns its bounded summaries. This is the authority for text and Voice continuity. |
| Browser Voice heard/spoken log | Browser-memory diagnostic state only | `_log` in `web/src/lib/voice-session-controller.ts` is not persisted or sent to COS. Voice-originated requests become persistent only when the sideband submits them through the same COS FIFO. |

Neither v0.32 nor v0.34.6 injected the Operator transcript into each new
provider call. Starting/restarting the provider session therefore discarded
its own temporary context independently of the intact COS conversation. This
is the source-confirmed reason a reactivated Voice Mode felt like a new
conversation.

## Hotfix state machine

### Voice lifetime versus text turn admission

Voice Mode is an audio interface to the one Operator conversation, but its
WebRTC/sideband lifetime is independent from text turn admission:

- Text retains the current receipt-backed `client_ref` behavior, reconnect
  reconciliation, ordered COS FIFO, draft retention, and normal Send/Stop.
- The inactive Voice orb remains available whenever the browser supports it;
  ordinary text work, a pending admission, or a draft cannot remove it.
- The only normal browser Voice ends are the explicit Voice control/Escape
  paths and an authoritative server `voiceEnded` event for that exact Voice
  session. Ordinary text Send and Stop only target the COS turn.
- Browser COS event narration no longer creates Realtime conversation items
  or responses. A text turn therefore has no browser-to-Realtime response
  creation path to collide with a Voice reply.

### Provider response admission

The sideband is the sole server-owned requester of Realtime responses for
sideband function output. It keeps one response admission slot and a FIFO:

1. It reserves the slot before sending `response.create`.
2. A later request waits in FIFO order.
3. `response.done` or `response.cancelled` is the only release/eligibility
   signal; it dispatches exactly the next request.
4. A provider active-response conflict moves the rejected request back to the
   FIFO and retains the busy state until that terminal provider signal.
5. Sideband reattach preserves this admission state for the same provider
   call. It does not treat reconnect or elapsed time as proof that a response
   is eligible.

There is no sleep/timer busy retry, no spin loop, no duplicate conversation
item, and no raw provider message/response identifier in Voice UI or trace.
A recoverable provider admission conflict leaves Voice connected.

If a locally attempted `response.create` write fails, WebSocket delivery is
ambiguous: retrying the same create could duplicate a provider response. The
sideband therefore releases only that request's pointer-identified reservation
and advances at most one already-queued successor. The successor either runs,
or receives the normal busy refusal and returns to FIFO order. A second local
write failure does not cascade unconfirmed attempts; remaining FIFO entries
wait for a later explicit admission opportunity. This is immediate
non-wedging local recovery, not a timer-based retry, and preserves
at-most-once `response.create` delivery under ambiguous transport failure.

### Read-only continuity tool

`get_operator_conversation_context` is a sixth Realtime tool. It is the
canonical, on-demand bridge from a new or re-established provider Voice call
to the one authoritative Operator conversation:

- Closed input: `view` is only `recent` or `continuity_summary`; no IDs,
  paths, workspace/browser selection, free-form range, or raw transcript
  dump is accepted.
- The bridge is fixed to the authenticated Voice session's one `cosRelay`.
  There is no HTTP route, URL/query parameter, browser-provided transcript,
  other-conversation lookup, or cache.
- `voiceConversationContext()` reads the currently running authenticated COS
  supervisor only. It does not call `get()`, start a sidecar, create a
  replacement conversation, submit a turn, or mutate the queue.
- The sideband derives this read from its cancelable lifetime context and the
  existing sync-tool deadline. A Close or an extraordinary supervisor stall
  therefore cannot leave the asynchronous tool dispatcher waiting forever.
- The server parses the existing bounded history summary into chronological
  `prior_user_turn` / `prior_operator_turn` entries. It excludes thinking,
  tool blocks/results, IDs, timestamps, errors, and diagnostics; it applies
  fixed count/size budgets: six recent or three summary turns, at most twelve
  prior items/7,200 characters and five current-work items/600 characters
  each. It redacts credential-like values including complete
  `Authorization: Bearer …` forms, provider response IDs, home paths,
  and e-mail-like identities. Active/queued
  user-visible prompts are the only current-work projection. Approval state
  is omitted because this path has no safe authoritative approval snapshot.
- History selection returns one contiguous newest suffix. When the next older
  item does not fit the fixed byte budget, selection stops rather than
  silently skipping it and presenting an apparently adjacent older turn.
- A tool lookup returns only a Realtime `function_call_output`, with no work,
  queue item, Voice end, or user-visible toast. Realtime's function-call flow
  requires an explicit continuation after that output: the sideband admits one
  `response.create` for the *already-spoken* request through the same FIFO.
  It is queued if the originating response has not yet reached
  `response.done`, or immediately admitted if it has. Thus either provider
  event ordering produces exactly one answer continuation, while passive
  Voice connect still creates none.
- Availability/errors are generic and do not disclose whether another
  conversation/session exists.
- Every call obtains a fresh read, so an accepted clear/reset immediately
  removes cleared material from future tool results. Voice end itself never
  clears Operator continuity.

The provider instructions name this tool and require it before answering
continuity-dependent speech such as “continue”, “as we said”, pronouns,
ellipses, or post-reactivation follow-ups. There is deliberately **no**
automatic startup context injection, greeting, response, narration, or tool
call: the fixed server instruction makes the tool discoverable without
colliding with active text admission or duplicating provider conversation
items.

### Quiet, retryable composer and compact geometry

The composer is a direct-manipulation surface, not a Voice diagnostic console.
Current v0.34.6 had no live availability probe; the quoted “Voice availability
could not be checked” wording belonged to the removed v0.34.5 App Voice
availability state. The actual current diagnostic path was
`voice-session-controller` storing a transient `_error`, followed by
`mux-cos` rendering that value as `.voice-error` with `role=alert`. This
hotfix removes both producer and renderer:

- failed token, SDP, provider, connection, and non-permanent capture attempts
  clean up only their own WebRTC/mic/sideband attempt and return silently to
  the ready orb;
- a Realtime active-response conflict remains connected and silent;
- only an explicit local microphone permission denial, an unsupported
  browser/capture stack, or an insecure context becomes a durable
  `blocked` state. The orb stays visible but is disabled, with a concise
  accessible label containing only the safe local action;
- no server/provider availability result, body, identifier, queue state, or
  error is rendered in the composer or used to hide/disable the normal orb.

The large empty composer had two independent source causes:

1. `mux-cos._fit()` writes an inline textarea height. `CosStore.send()` keeps
   the draft until its receipt, so `_submit()` measured the still-present long
   draft. On later `cos-turn-result` draft clearing, no sizing function ran;
   the old inline height survived the reactive value update.
2. `_holdVoiceComposer()` measured the whole current `.cbox` and
   `_renderVoiceComposer()` copied that historical height inline onto the
   solo Voice box. A long previous draft or status row therefore persisted as
   an empty tall Voice composer.

The fix makes sizing value-owned rather than activity-owned: `_fit()` grows
only a nonempty current draft up to CSS's existing `max-height` and enables
its own overflow; empty/currently sent input clears inline sizing
synchronously. The post-render synchronization observes a changed
authoritative draft value, including receipt/reconnect clearing. Voice solo
uses only its intentional compact orb minimum and never copies the prior
composer's measured height. The visible `.queue-status`, `.voice-error`, and
dictation status nodes are removed, not CSS-hidden; Send/Stop labels still
communicate their direct action, and the live microphone indicator remains
visible without `aria-live` state chatter.

## Retained v0.32 boundary and scope-out

The browser still sends only transcription configuration in its
`session.update`; normal provider turn detection remains provider-owned. This
hotfix does not add `create_response: false`, App Voice routes/leases,
capture arbiters, manual VAD/endpoint gates, bubbles/title controls, Lobby,
context pickers, multi-channel routing, or a Voice-specific transcript store.

`Operator` remains the human-facing name. Historical
`*_chief_of_staff` tool identifiers remain wire-compatible identifiers only.
The two earlier security hardenings remain: body-free provider mint/SDP
browser failures and configuration-directory publication protection. Server
mint/connect logs retain only `voice.SafeDiagnostic`'s finite classified
detail (for example safe HTTP status/auth-mode guidance); unclassified
credential, endpoint, provider-body, call-ID, and transport errors reduce to
fixed text. Sideband trace/log output contains no provider body or call ID.

## Validation boundary

Repository policy prohibits adding or changing isolated unit/protocol tests;
the review-specific response-order and write-ambiguity claims are therefore
source-traced, not fixture claims. Ordinary compile/type/static checks can
establish source and wire-shape properties only. No DTU, browser automation,
microphone, synthetic audio/WebRTC/provider session, credentials, or live
provider run is used as acceptance evidence for this hotfix. Live user Voice
Mode validation after release remains the acceptance test for acoustic
continuity and interruption behavior.