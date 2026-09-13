# Direct Operator handoff — release checkpoint

## Target and baseline

The requested behavioral baseline is v0.32.0, annotated tag object `8ae58f835abadf14b5069870e932446548b756a7`, peeled commit `4c5f897c7759f6776e95cada2f00aa36911ae9f2`.

In that baseline, a spoken request selected `ask_chief_of_staff` for short work or `dispatch_chief_of_staff` for long work. Both called the same COS relay and native Operator session as typed Mission Control. The sideband acknowledged work, waited for the real turn, and injected/narrated progress or its terminal answer. Native tool approval, cancellation, and spoken end were distinct mechanisms.

## Released regression and exact correction

v0.34.2 (`b40bd3bc69bf554aa593184d81458e140b03ca91`) restored much of the bridge but retained a browser `submit_thread_turn` operation and the generic `Send voice-requested work?` confirmation. It therefore stopped ordinary voice work at an unnecessary browser receipt.

The correction removes that ordinary handoff route. A correlated realtime ask/dispatch now validates the active server-owned lease, provider call/item/response mapping, canonical Operator root, and sidecar readiness, then calls the same `cosRelay.submit` path directly. It retains deterministic client-reference deduplication and exact lease-local turn ownership. Result/progress/approval narration remains correlated to the originating provider capture.

The provider’s advertised app profile is the original five conversational tools and full v0.32 instructions with prose-only `chief of staff` -> `Operator` naming. The browser’s later `session.update` no longer overwrites mint-time instructions/tools/VAD; transcription is included in the server mint profile. An unspecified configured output voice remains omitted, not serialized as an empty string.

## Minimum source surface

The smallest product surface for this correction is limited to the direct bridge and the retired browser-confirmation path:

- `internal/server/app_voice.go` — direct canonical-root admission, precise correlation/dedup, scoped cancellation through `CancelSpecific`, and progress/approval/result lifecycle.
- `internal/server/cos.go` — reject obsolete browser app-voice references from the normal COS socket path.
- `internal/voice/{bridge.go,tools.go,client.go,sideband.go,endsession.go}` — restored conversational contract, fixed mint profile, correlated relay/narration/end, and explicit rejection of unadvertised app-operation names.
- `web/src/components/mux-cos.ts` — remove the generic confirmation and retain the existing integrated composer/orb with type/back, compact pause/resume, draft/caret return, and in-place Send/Stop.
- `web/src/{app.ts,ws.ts,lib/app-voice-operations.ts,lib/cos-store.ts,lib/voice-session-controller.ts}` — remove the now-retired browser work-submission/confirmation route and prevent the browser session update from replacing the server contract.

No cold-hover, multi-channel, Lobby, floating bubble, header/dock launcher, storage, credential, provider setting, or production service behavior is changed.

## Verification checkpoint

A fresh isolated DTU run using actual Chromium, WebRTC, muxterm server/sessiond, and a real native Amplifier-backed canonical Operator root passed the direct proof. Deterministic loopback provider boundaries were used only for controlled function events and native Amplifier replies.

- One valid direct ask caused exactly one native Operator provider turn and `turn_start -> delta -> turn_end`.
- The correlated function result and narration continuation were emitted.
- Browser app-operation count, browser `cos-turn` count, and generic confirmation count were all zero.
- Delayed dispatch/progress/final narration, native two-step approval denial, exact lease-local cancellation, pause, barge-in, spoken end without canceling admitted work, shared typed follow-up history, and invalid/replayed event protections were separately exercised in the isolated runtime.
- Final focused regression additionally verified direct ask still works while unadvertised historical app-operation names are rejected without Operator, navigation, draft, or browser-operation effects; the rebuilt test binary SHA-256 was `701cd900fb0d16e57d57b69d03faefe63fd7d0cb2a9425bfc5db3fc34fb6e04b`.

This is fixture-qualified integration evidence, not real Azure speech, physical microphone/acoustic delivery, or Android Chrome evidence. No production instance, user configuration, credentials, histories, sessions, panes, or updater were touched.
