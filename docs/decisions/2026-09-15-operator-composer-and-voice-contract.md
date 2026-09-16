# Operator Voice Mode compatibility record

**Restoration baseline:** `v0.32.0` / `4c5f897c7759f6776e95cada2f00aa36911ae9f2`
**Reconciled target:** `origin/main` / `8cfe4caecf2d1f3e6cd04937fb2b85d1e0b6e2be`

## Restored behavioral boundary

Voice Mode restores the released v0.32 browser WebRTC and server-side sideband
flow: protected `/api/cos/voice/token`, `/api/cos/voice/sdp`, and
`/api/cos/voice/end`; an ephemeral browser-only provider secret; provider-derived
call identity; and the server-side tool/approval/farewell bridge. The browser's
`session.update` asks for transcription only. It deliberately does not set
turn-detection/VAD values, `create_response: false`, local endpoint gates, or an
App Voice delivery policy.

The composer owns live Voice Mode. With an empty draft, its orb occupies the Send
slot. From `connecting` through call end it takes over the composer, preserving
draft/caret/focus and reader position. `type instead` returns to the text composer
without hanging up; returning to the orb reverses it; Escape or the orb ends the
call. This does not restore Lobby, contexts, threads, per-workspace voice, a
floating bubble, or title/dock controls.

## Retained current Mission Control/text behavior

Mission Control remains the one persistent server-owned conversation. Durable
draft storage, FIFO text admission/queue/reconnect behavior, ordinary Send/Stop
semantics, and one-shot composer dictation remain current behavior. Dictation
only fills the durable draft for review and never auto-sends. Live Voice Mode
uses its restored provider-owned response flow but submits tools through the
current canonical COS relay with empty owner/client-reference values so distinct
spoken turns never share a constant idempotency key.

## Identity compatibility

`Operator` remains the only human-facing assistant name in UI labels, tool
descriptions, spoken-provider instructions, narration, and user-facing errors.
The five v0.32 provider tool identifiers retain their historical wire spelling
(`ask_chief_of_staff`, `dispatch_chief_of_staff`, and
`cancel_chief_of_staff`) because changing identifiers would alter the provider
tool contract. Their model-visible prose uses `Operator`; this has no effect on
endpointing, turn ownership, tool execution, approval, or farewell behavior.
`Tank` remains only an existing display alias.

| Restored area | v0.32 source | Intentional departure | Behavioral effect |
| --- | --- | --- | --- |
| Provider tool IDs | `*_chief_of_staff` identifiers | Retained as wire compatibility identifiers | None; tool dispatch remains the same |
| Provider-visible prose | Chief-of-Staff wording | `Operator` wording at tool/session/narration boundaries | Identity only; no turn/endpoint change |
| COS bridge call | Three-argument relay submit | Current `(supervisor, prompt, "", "")` FIFO call | No shared idempotency key; distinct spoken turns remain distinct |
| SDP lifecycle | No duplicate-connect fence | Current generic `connecting` and end-during-connect guards | Rejects duplicate/racing SDP exchanges without App Voice state |
| Provider errors | Provider response snippets on some failed check/mint/SDP requests | Fixed body-free error/recovery messages | Credential protection only |
| Publication root guard | Rejects config directory and descendants | Also rejects an ancestor containing the config directory | Credential protection only |

## Approved security-only deviations

1. Voice check, mint, and SDP failures never copy a non-success provider body
   into a browser response or log. They use bounded fixed status/recovery text.
2. Publication rejects a resolved root that equals, is inside, or contains
   muxterm's configuration directory, protecting stored Voice Settings keys.

Neither deviation adds an App Voice lease, app operation, VAD profile, endpoint
gate, capture correlation, or delivery policy.

## Validation boundary

Source comparison, removal searches, type/static checks, and compilation establish
code and dependency compatibility only. No synthetic WebRTC/provider fixture,
browser automation, microphone, credentials, or live provider session is used as
acceptance evidence. Real microphone/provider/conversation acceptance remains
explicit user validation after release.