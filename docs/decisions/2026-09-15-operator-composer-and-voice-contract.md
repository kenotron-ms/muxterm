# Operator composer and Voice Mode contract

## Evidence and boundary

Mission Control is one persistent conversation, with no Lobby, context picker, or
per-workspace voice lifetime (`docs/designs/2026-09-12-app-voice-two-lifetimes.md`,
sections 1 and 2). Its server-side `cos.Supervisor` already provides the required
single-consumer FIFO queue (`internal/cos/queue.go`): an accepted turn is created
before dispatch and queued turns survive a sidecar restart. The correction below
uses that queue; it does not invent a pretend "steer" operation that the backend
cannot honor.

## Independent state

The UI derives three independent values:

| Concern | Authority | May affect |
| --- | --- | --- |
| Text composer | draft, admission receipts, and the Mission Control socket | Send availability and queued-turn presentation |
| Operator work | the COS turn stream and server queue | Whether there is an active turn and which already-accepted turns wait |
| Voice Mode | browser WebRTC/media capability, runtime voice availability, and the app voice lease | Only the Voice Mode control and its recovery message |

No voice value can disable the textarea, change its selection, discard its draft,
or decide whether a text turn is sent. Likewise, an Operator turn is not a reason
to hide or end a usable Voice Mode connection.

## Text invariant and routing

The text area is always editable after it is rendered. Voice status lookup,
credential minting, `getUserMedia`, lease claim/loss, WebRTC setup, an active
lane/tool/stream, and browser microphone permission are not editability gates.
Its draft is held in tab session storage so a normal refresh restores an
unsubmitted draft; unavailable session storage remains a non-fatal loss of
stickiness, not a disabled composer.

A submitted message uses the existing server-owned FIFO:

1. The browser sends `cos-turn` in submit order and keeps the draft until that
   request receives `cos-turn-result`.
2. The relay serializes startup admissions, then gives each accepted message a
   turn ID and enqueues it in `cos.Supervisor`. The queue runs one turn at a time.
   If work is already active, this is automatically **queued for the next turn**.
3. The server publishes the accepted queue snapshot, so a reconnecting or
   refreshed browser rebuilds the ordered pending rows even before the sidecar
   has dispatched them. A pending row says “Queued for the next turn”; it never
   claims to alter an already-dispatched tool action.
4. A failed or unconfirmed admission leaves the draft intact. The person can
   retry explicitly. An accepted queue entry survives a browser refresh,
   WebSocket reconnect, a voice lease transition, and a recoverable sidecar
   restart. It cannot honestly survive a permanent server/supervisor shutdown;
   that failure is reported as such rather than silently replayed.

There is no direct-steer UI in this revision because the current server protocol
has no reliable operation that can safely modify an active Operator turn.

## One primary composer control

The circular primary control has a deliberately small state machine:

| Active Operator turn | Draft | Primary press | Stop access |
| --- | --- | --- | --- |
| no | empty | disabled Send icon | not applicable |
| no | present | Send | not applicable |
| yes | empty | Stop active response | primary control |
| yes | present | Queue message | hold the same control, or press Arrow Down while it is focused, to open its compact action menu and choose **Stop active response** |

The draft-present state makes sending the safe default: a normal tap, Enter, or
Space on the focused primary button cannot accidentally stop work. The compact
menu exists only while an actual streamed turn is active; it contains one
explicitly named Stop action, no duplicate permanent stop button, and never
clears accepted queued turns. Escape closes the menu. The control exposes the
same action and recovery instructions through its accessible name/description,
and its coarse-pointer target remains at least 40px.

Stop is a single deliberate action: it immediately cancels the specifically
active sidecar task so the FIFO receives one terminal cancellation event. It
does not require a hidden second click, and it never cancels queued turn IDs.

## Voice Mode states

Voice Mode stays rendered beside the primary composer control and remains
independent of Operator busy state. It is disabled only for one of these actual
voice-specific conditions:

| Condition | Visible message |
| --- | --- |
| availability check in progress | “Checking voice availability…” |
| browser lacks WebRTC/microphone support | “Voice mode needs browser microphone support.” |
| server has voice switched off | “Voice mode is off for this server.” |
| server configuration is invalid | “Voice mode needs valid server settings.” |
| runtime provider is unavailable | “Voice provider is unavailable. Try again shortly.” |
| availability check failed | “Voice availability could not be checked. Try again.” |
| microphone permission denied | “Microphone permission was denied. Allow it, then try again.” |
| no microphone | “No microphone is available. Connect one, then try again.” |
| lease, mint, or WebRTC setup failed | “Voice session could not start. Try again.” or “Voice connection could not start. Try again.” |

Recoverable errors make the Voice Mode control a Retry action. A normal user
exit is silent; raw provider responses, lease event names, token details,
completed-work extracts, and server internals are never rendered.

An active Voice Mode connection does not survive a browser refresh or owner
connection loss: browser media and the owner lease are deliberately released and
must be started again. The text draft and accepted Operator queue are separate
from that lifetime, so neither is lost merely because voice ends.