# Operator chat

An operator is a regular chat promoted in place. Its harness, history, project,
and composer stay the same. The operator gains durable links to up to twelve
other chats, which may use different harnesses. A linked chat can itself be an
operator; cycles are rejected.

## Flow

1. Open the permission and mode menu in any chat's composer and turn on
   **Operator mode**. The right drawer opens to **Status**, next to Files. The
   sidebar uses a network icon in place of the chat's status dot while
   operator mode is on. The same switch turns it off.
2. Ask the operator in the ordinary composer to start a lane with a chosen
   harness or attach an existing chat. The Status tab displays progress, links
   to full chats, and offers quick actions to unlink or archive a lane.
3. Every operator turn
   receives standing instructions and the current linked lane IDs and states.
   The operator uses `spawn_operator_lane`, `link_operator_lane`,
   `unlink_operator_lane`, `get_operator_lanes`, `send_chat_message`, and
   `read_chat_session` through the muxterm MCP bridge. A new lane is linked
   before its opening turn, so its reporting contract is active from the start.
4. Each linked harness's event bridge reports start, tools, completion,
   cancellation, failure, uncertainty, and goal milestones. Plan and todo tool
   payloads become a shared checklist and task count. Without a plan, the
   Status tab shows historical time ranges when enough completed human turns
   are available. Hook percentages are never presented as percent complete.
5. Lifecycle updates appear in one lane status card in the operator transcript.
   A completed turn, or a terminal full goal run, finishes that card and writes
   a durable source-attributed report. The server submits the report to the
   operator harness as an `operator-lane` input so it can summarize the outcome
   and blockers for the user. The report is never a human user bubble.
6. Open a lane only when you want its full conversation. The **Operator mode**
   switch in the composer returns the chat to regular mode and removes its
   links while preserving the chats and their histories.

## Screen shape

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Chat title                                             [chat | split | tab] │
├──────────────────────────────────┬──────────────────────────────────────────┤
│                                  │ [Status] [Files] [Changes] [Terminal]  │
│  You: Ship the search changes.   ├──────────────────────────────────────────┤
│                                  │ Operator status                       │
│  Operator: I started Codex and   │ 3 lanes · 2 working · 1 needs attention│
│  Claude lanes. I will report     │ [All] [Needs attention] [Running]     │
│  back on their outcomes.         │ [Done]                               │
│                                  │ ┌──────────────────────────────────────┐ │
│  ┌ Search API · Complete ────┐   │ │ Lane          Time / tasks      Open │ │
│  │ API ready; one blocker…   │   │ │ Search API    ~2–12m             ↗  │ │
│  └───────────────────────────┘   │ │ Codex · Working    ▂▅▃▇ remaining   │ │
│  Operator: Search API is ready…  │ │ Latest reply in Markdown             │ │
│                                  │ │ Unlink lane            Archive chat  │ │
│  UI review · failed · Error...   │ └──────────────────────────────────────┘ │
│  [Ask: start a Claude lane…]     │                                          │
│  [Permission · Agent · Operator] │                                          │
└──────────────────────────────────┴──────────────────────────────────────────┘
```

## Status contract

The Go-owned chat record is the durable relationship. It stores `operator` and
`operatorLanes`. Linked lane snapshots come from the same chat records the
browser already reads. Their `state`, `lastActivity`, and `lastOutput` are
updated from the SDK sidecar event stream, including Amplifier and ACP harness
events. Native plan tools supply todos and a completed/total task count.
Historical completed human turns supply effort and remaining-time ranges. A
send receipt proves only acceptance. The UI never treats it as task completion.
A failed, uncertain, or stopped lane stays visible and needs attention. Operator
milestones and sourced reports are durable journal events, so reopening the
operator preserves its timeline.

The automatic report dispatcher writes a durable receipt before submitting an
input. If acknowledgement is lost, it records uncertainty and does not replay
the input blindly. A busy operator waits until its turn completes. The
operator's `input.accepted` event retains source `operator-lane`; the transcript
shows the durable report card and does not render that accepted input as a human
message. The operator's response remains an ordinary assistant message.

The Status tab polls while it is open to show ongoing tool activity and text.
It stops polling when the tab closes. Lifecycle milestones arrive in the
operator chat over its existing event stream. Operator instructions are added
server-side for both browser sends and MCP control sends; the user's displayed
message remains unchanged.

The Status table defaults to **All**. **Needs attention** contains failed,
uncertain, and cancelled lanes; **Running** contains starting and working
lanes; **Done** contains ready lanes that were not cancelled. A cancelled
turn is labeled **Stopped** until another turn starts. Archiving a chat
changes its sidebar placement only: an archived lane keeps its operator link,
reporting contract, state, and filter
category. It is marked **Archived** in Status and can be restored there.
Archiving a linked lane happens immediately and can be reversed with
**Restore chat**. **Unlink lane** removes only this operator's link; the chat
and its archive state remain intact. Status
snapshots contain only chats currently named by that operator's link list.

Timing uses completed human turns from the last 180 days of local SDK chat
journals. An asynchronous classifier chooses review, focused, cross-stack, or
operational scope for the latest lane request, including a report sent to a
nested operator. Historical samples still use human requests only. It tries
OpenAI Decisions with the existing Amplifier `keys.env` credential, then Anthropic's normal API,
then a local wording classifier. Provider failures never block Status. The
chosen category selects historical examples; fewer than eight examples in
that category use all recent turns and are labeled as broad history. The
displayed effort range spans the observed 10th to 90th percentiles. For a
running lane, a remaining range uses only examples that ran longer than the
current elapsed time; fewer than five such examples yields "Time uncertain."
The sparkline bars show completed tasks, or elapsed time against the upper
historical range, and are not a percent-complete claim. The collapsed row
shows a compact time range; a tooltip gives the sample count and uncertainty.
The expanded row shows only the latest Markdown reply and lane actions.
Completed-turn history is an imperfect proxy for whole goal runs; there is
currently too little whole-goal history for a separate range. No model
confidence score appears in Status.

This first version coordinates SDK chats. Terminal panes managed by sessiond
remain in the existing fleet and are not linkable as operator lanes here.
