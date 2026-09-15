# Operator output and endpoint policy

## Historical evidence and correction

`v0.32.0` (`4c5f897c7759f6776e95cada2f00aa36911ae9f2`) left input
turn detection to the realtime provider. Its browser `session.update` added
transcription only; it did not issue `response.create` from a
`input_audio_buffer.committed` observer. The repository's recorded provider
measurement gives the gpt-realtime-2.1 server-VAD profile as threshold `0.5`,
prefix padding `300ms`, silence duration `500ms`, and interrupt response
enabled (`docs/research/realtime-voice.md`).

App Voice introduced `create_response: false` plus immediate
`committed -> RequestScopedResponse` so the server can correlate a response
to one Operator handoff. That correlation is still required, but the immediate
request bypassed the user-visible forgiveness that the old provider-owned
turn boundary supplied.

The app profile explicitly restores the measured server-VAD values. The
provider's `silence_duration_ms` is the one cancellable grace window: its
documentation defines `speech_stopped` as the event emitted after that duration
of silence. Resumed speech before that expiry remains in the same provider turn.
The local gate accepts a manual correlated `response.create` only after the
provider's `speech_stopped` and matching `committed` boundary; it deliberately
adds no second timer after either event.

The exact effective v0.32 value of `gpt-realtime-2.1-mini` was not captured in
the tag; the code inherited provider defaults. The explicit 2.1-family values
above are the repository's only measured release-era compatibility evidence.
No semantic-VAD/eagerness or idle-timeout field existed in the old or current
profile, and none is introduced.

## Endpoint and interruption contract

| Signal | Effect |
| --- | --- |
| `speech_started`, no assistant playback | cancels any pre-commit endpoint ordering state and starts/continues a user turn |
| VAD silence duration | the provider-owned 500ms cancellable grace; resumed speech resets it before an endpoint is emitted |
| `speech_stopped` | provider confirms the VAD grace expired; still never creates speech or dispatches Operator alone |
| `input_audio_buffer.committed` | after the matching stop, creates the one correlated manual response |
| resumed `speech_started` before `committed` | invalidates the held commit |
| `speech_started` during assistant playback | provisional only |
| matching `output_audio_buffer.cleared` or `response.cancelled` | provider confirms a deliberate barge-in; then accept the provisional input |
| playback echo/noise without provider interruption evidence | never becomes a user turn or response |

The browser never sends a cancel for ordinary speech; provider/WebRTC remains
the barge-in authority. Pause and explicit shutdown retain their existing
separate cancellation path.

## Delivery taxonomy

There are three deliberately different destinations:

1. **Fleet/task state and optional transcript** retain relevant tool, lane, and
   turn detail for people who open them.
2. **Operator conversation UI** renders actual turn text, approvals, and
   material failures; it does not manufacture a message from a heartbeat.
3. **Spoken Voice Mode** is stricter. It may create a provider response only
   for:
   - a direct answer to the just-completed spoken request;
   - a requested final task result;
   - a concrete human decision/approval question;
   - a material blocker or safety-critical failure.

Routine tool start/end, queue acceptance, lane heartbeat, preview retrieval,
status refresh, reconnect, lease lifecycle, VAD edges, partial transcript,
internal error extract, and unrequested "working" acknowledgement are
`routine` and cannot create spoken output.

## Central policy and deduplication

`internal/voice/delivery_policy.go` is the single Voice Mode promotion seam.
It classifies a candidate as direct reply, task result, decision, blocker, or
routine. Routine and ambiguous candidates fail quiet. Other classes require a
stable hash of delivery class, capture ID, provider item/response ID, and
semantic content. A key is admitted once for the sideband lifetime, including
sideband reconnects within a 10-minute replay window. The ledger stores only
fixed-size digests and expires old keys instead of turning later direct
answers, decisions, blockers, or results silent at an arbitrary count.
Provider call replay fencing and capture state remain in force separately.

The app service emits only approval events to the delivery sink; routine
`tool_start` events remain in the Operator transcript/fleet path. Browser
refresh or lease loss tears down Voice Mode and its delivery ledger. Accepted
text/Operator work remains server-owned; a later voice session never replays
old progress merely because it reconnects.

If a sideband reconnect loses the matching output-buffer terminal event while
audio might still be draining, the server cannot safely distinguish a later
echo from a person. It ends only that unsafe Voice Mode lease with the existing
plain restart affordance rather than guessing; no Operator work or queued text
is cancelled.

Accessibility announcements remain for explicit user control outcomes:
permission errors, Voice Mode failure/retry, approval prompts, and Send/Stop
actions. The policy does not suppress user input, direct answers, fatal
failures, or an explicit control's accessible feedback.