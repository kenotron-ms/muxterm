# Chat presentation vocabulary

The SDK chat event stream is the source of truth. Web and native clients project
the same event types into these visible concepts; they do not infer turn state
from message text or a timer.

| Concept | Events | Presentation |
| --- | --- | --- |
| User message | `input.accepted` with `kind=user` | Right-aligned tinted bubble; show attachments and copy action. |
| Steering message | `input.accepted` with `kind=steer` | "Your interjection" inside the active turn's work disclosure. |
| Assistant reply | `assistant.delta` | Plain transcript text, outside a bubble. Consecutive deltas join. |
| In-turn note | `commentary.delta`, or assistant text followed by `assistant.interim` | Inside the turn's work disclosure. |
| Work activity | `work.activity`, `tool.*`, `delegate.*`, `operator.lane.*` | Compact expandable work disclosure with outcome and duration. |
| Question | `question.requested`, `question.suggested`, `question.answered`, `question.resolved` | A question card with pending or answered state. |
| Running turn | `turn.started`, then a message or activity before a terminal event | Working indicator; composer can send a steering message or stop the turn. |
| Completed turn | `turn.completed` | Work disclosure becomes a completed summary. |
| Stopped turn | `turn.cancelled` | Keep partial output and label it stopped. |
| Interrupted turn | `session.uncertain` | Explicit recovery warning; never silently mark it completed. |
| Error | `error`, `voice.session.error` | Visible error row. |

Message actions use the same terms on both surfaces: **Copy** for user and
assistant text, **Edit in a new chat** for a completed user message, and **Fork**
for a completed assistant reply. The branch endpoint selects a turn in the
server journal; a native client must resolve the absolute journal turn before
requesting a branch, since a visible history page can begin mid-chat.

The composer is one raised surface. Its text area stays available during work;
the main action changes from send to steer when text is present, and to stop when
the turn is running and the draft is empty. An attachment can only be sent with a
new user message. All clients use the same names for these actions and states.
The composer presents the server's actual permission, mode, and model; selecting
them opens native controls backed by the chat settings endpoint. Assistant
Markdown remains native text and layout. Raw HTML is displayed as text.
