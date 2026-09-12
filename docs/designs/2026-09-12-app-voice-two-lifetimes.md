# App voice: two lifetimes — 2026-09-12 correction

Authoritative user correction to the multichannel voice design. This addendum supersedes channel-attached conversational voice assumptions; it does not reopen the closed Sandbox lifecycle policy or enable production features. Implementation/verification status belongs in the feature ledger, not in this contract.

## Explicitly superseded

- Mandatory voice teardown, drain and provider remint on channel selection.
- Equating the app conversational voice session/lease with a workspace agent thread.
- Interpreting Sandbox hide feedback `Voice detached. Chat: Lobby.` as permission to kill app-wide voice. Hide may cancel origin-composer dictation and invalidate target-specific work authority; the app bridge stays available.
- Treating absence of browser-local SpeechSynthesis voices as evidence that provider audio is unavailable. Use the established app provider audio architecture, not another TTS subsystem.

## Two independent lifetimes

**Composer dictation** is owned by its originating channel/composer identity and capture generation. Before leaving that channel, synchronously invalidate its capture, stop recording and cancel outstanding transcription. Late partial/final STT must not append or submit to either the departed or newly selected channel. Preserve accepted draft text; never cancel submitted work, clear another draft or stop conversational mode. Pane/applet navigation with the same composer channel does not itself cancel dictation.

**Conversational voice mode** is owned by the authenticated app/browser session and an app-wide lease, never by the selected workspace thread. One client/provider bridge survives channel, Lobby, workspace, pane and applet navigation. Navigation is observation, not utterance cancellation, task retargeting, automatic microphone permission or provider replacement. Explicit Stop, logout, revocation, lost owning connection and explicit competing-tab takeover revoke/fence the appropriate lease. A hidden/invalid workspace loses only its target-specific authority, not the app bridge.

One explicit microphone arbiter prevents simultaneous hidden dictation and conversational capture. Switching modes requires visible user intent and completion of the previous capture's release; navigation never starts capture.

## Candidate release gate

App voice is candidate-only, not a production live-permission grant. Registration requires valid enabled legacy `[voice]` configuration and the independent `missioncontrol.voice_preview` gate; `missioncontrol.threads_v2`, `missioncontrol.text_preview`, `missioncontrol.voice_preview`, and `voice.enabled` all default off. Runtime status reports registration rather than on-disk `voice.enabled`, so a completed UI may be released disabled and cannot start the candidate without the server-side gate.

## App operations and authorization

Reuse existing authenticated app handlers and native validation. A finite provider tool schema can expose:

1. Enumerate known machines/workspaces/lanes and current fleet status.
2. Select a known workspace/thread, or a known pane/applet/detail view.
3. Bounded read of a known lane transcript, with native session ID and machine attribution, clipping, privacy and access checks intact.
4. Inspect/target a channel composer; set its draft without submitting.
5. Explicitly submit requested work to an immutable validated thread through the existing turn-dispatch path.

No arbitrary shell, raw pane input, credentials, deletion, approval bypass or automatic expansion of rights. Existing confirmation/ownership gates remain gates. Unknown sessions/remotes refuse visibly, never local fallback. Missing safe authenticated seams are explicit residuals, not invitations to patch protected bundles, personal/cached instructions, or upstream Amplifier.

## Routing and concurrency

View selection and work execution target are separate values. Navigation updates only a bounded app-state observation (active view/channel/composer and revision); it does not inject full histories. A named routing request resolves a known identity, selects with authoritative acknowledgement and only then populates/submits as requested. Draft writes do not imply submit intent.

At each work submission bind thread UUID, machine identity, runtime session/generation/incarnation and provider turn/call/capture identity. Validate again at admission. Resolve `here` against an explicitly acknowledged app-context revision: concurrent ambiguous focus change refuses or asks a question, never silently sends to the new focus. A delayed A result remains attributed to A while B is visible. App voice may narrate `In A...` without changing view. Announce successful voice-driven routing and answer source/destination, not every click/navigation. Multiple authorized lane reads are intentional app-bridge context; workspace-agent histories remain independent.

Retain existing backend exact-call deduplication, server-side authorization, immutable root admission and separate work/narration completion tests. Replace only the invalid per-channel lease/navigation-remint expectations.

## Compact implementation and verification checklist

- [ ] Separate composer dictation invalidation from app-wide bridge lifecycle; preserve accepted drafts and submitted work.
- [ ] Reuse one app-session provider connection and explicit mic arbiter; remove navigation teardown/remint and local-TTS prerequisite.
- [ ] Implement finite app operation schema through existing authenticated handlers; separate observed context from execution target.
- [ ] Fence ambiguous focus, stale generation, duplicate calls, disconnected owner, Stop/logout/revocation/takeover and invalid targets.
- [ ] Verify in a separate immutable candidate snapshot inside the existing owned DTU: real browser/server/sessiond/sideband, actual root dispatch and captured provider inputs.
- [ ] Check late dictation STT A→B (accepted A draft retained), same bridge A→B→Lobby/pane/applet, voice selection→draft→explicit submit, transcript attribution/unknown remote refusal, delayed A result in B and rapid click/voice conflict.
- [ ] Keep per-feature PASS/FAIL/BLOCKED evidence. Scripted STT/provider events/audio ACKs are protocol fixtures, not microphone or acoustic proof. Live provider/microphone access remains a separate explicit user-enabled gate.
- [ ] Preserve frozen text PR/preview, protected bundles, unrelated lanes and production. Review/checkpoint the bounded correction and record exact residuals without claiming unimplemented features complete.

## Implementation wire contract (v1)

`.artifacts/app-voice-wire-contract.json` is the implementation-facing source of truth for the bounded correction. It defines one app-global, owner-connection-bound lease and provider bridge; API version 1 is independent of the existing thread-attachment voice protocol v3. The owner receives a one-time WebSocket-issued `control_token`; every `/api/app/voice/{token,sdp,end}` request requires existing protected-route authentication, exact same-origin checks, `X-App-Voice-Protocol: 1`, and `X-App-Voice-Control`. Token, SDP and End all name the exact current lease epoch and provider session. Navigation cannot change either.

The finite provider surface is exactly `app_observe`, `navigate_app`, `read_lane_transcript`, `composer_draft`, and `submit_thread_turn`. Observations are monotonic owner-WebSocket revisions and bounded validated identity metadata, never history or provider context. UI operations have an exact 10-second, eight-pending owner cap. User click/keyboard navigation refuses pending operations before changing observation; an operation's own authoritative navigation acknowledgement may advance the revision only when its operation ID and exact target match.

`submit_thread_turn` is intentionally stricter than a model intent: a visible user confirmation must invoke the existing `threadStore.send` / `missioncontrol-turn` path, including immutable target, draft reference, live-runtime validation and catalog admission. Draft inspection/set never submits. Transcript reads require exact current fleet `{machine, session_id}` attribution through the existing bounded native reader; no paths or local fallback are accepted. Explicit takeover requires the prior browser's nonce drain acknowledgement after local tracks and sink release; connection closure alone is not drain proof. Composer dictation pins `channel_id`, `capture_id`, and `stt_event_generation`; channel departure invalidates that triple but keeps accepted draft text. The microphone arbiter has only `none`, `composer_dictation`, and `app_conversation`; empty browser SpeechSynthesis voices never disable the provider WebRTC path.

## Shared title control and floating bubble — 2026-09-12 UI correction

The canonical top-right title action order is **[voice circle + FOUR rounded vertical bars] [...]**. One shared Lit button renders in desktop workspace title chrome, desktop Mission Control title chrome, and the narrow/mobile shared title bar. The button remains visible when unavailable, with an explanatory accessible description; `Start voice mode` is the only activation intent. Connecting is pending, not listening. While active the title control is pressed and labelled `Stop voice mode`, even when composer state or navigation is busy. No composer-local voice MODE activators remain; composer dictation retains its separate mic.

One app-root floating circular control survives workspace/channel/pane/applet navigation, above ordinary content and below modal/reconnect layers. Its plain outlined circle and four-bar interior have no blur, shader, glow or soft shadow. Short visible labels distinguish Connecting, Listening, Thinking, Speaking, Mic muted and Error. Movement reflects actual available state/input measurements, never a simulated microphone. Provider audio is not contingent on local SpeechSynthesis. Error does not look listening.

Tap opens explicit Stop/Mute and position controls. Drag uses native Pointer Events, pointer capture and a six-pixel threshold; release snaps toward the nearer left/right edge over at most 160 ms, preserving vertical position. Drag never dismisses, changes execution target, submits, activates underlying content or requests media. Only `{edge, vertical}` presentation state is retained; normalized position clamps against visualViewport, safe-area and resize/orientation changes. Controls have at least 44 CSS-pixel targets. Keyboard alternatives dock left/right, move vertically or reset; Escape closes the control menu, not voice mode. Reduced motion removes transitions. The root overlay has no hit-test scrim. Menu height is constrained and scrollable on narrow/keyboard-sized viewports.

Mute disables the existing input media tracks while retaining the same app/provider session. Stop releases the owning tracks, audio graph and peer through the app controller. Navigation never starts a capture or changes either action into a channel operation. Actual provider tool wiring, per-submission target fencing and separate dictation cancellation remain part of this correction, not replaced by a visual feature.

Verification is layered: actual rendered app/server/sessiond screenshots may use the components' public presentation snapshots with a visible **VISUAL FIXTURE - no live microphone or provider** label. Such screenshots prove layout, state rendering and gestures only; they do not prove live session persistence, audio delivery, mute/stop hardware cleanup, or recognition. Runtime status and precise remaining gates are recorded in `.artifacts/feature-status.md`; no production/default enablement follows from this UI addendum. The icon is original SVG, not copied reference code; no React, third-party physics library or hosted script is introduced.
