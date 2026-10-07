# Operator chat

An operator is a regular chat promoted in place. Its harness, history, project,
and composer stay the same. The operator gains durable links to up to twelve
other chats, which may use different harnesses. A linked chat can itself be an
operator; cycles are rejected.

## Flow

1. Open any chat and choose **Make operator** in the top bar. The right drawer
   opens to **Status**, next to Files.
2. Attach existing chats, or enter a task and choose a harness to start a new
   lane in the operator's project. Newly created lanes are linked before their
   first turn, so the opening request receives the lane reporting contract.
3. Ask the operator to coordinate work in the ordinary composer. Every turn
   receives standing instructions and the current linked lane IDs and states.
   The operator can use `spawn_chat`, `send_chat_message`,
   `link_operator_lane`, `get_operator_lanes`, and `read_chat_session` through
   the existing muxterm MCP bridge. It passes `operator_id` when spawning a
   lane so the link exists before the opening turn.
4. Each linked harness's event bridge reports start, tools, completion,
   cancellation, failure, uncertainty, and goal milestones. Plan and todo tool
   payloads become a shared checklist and percentage. When there is no plan,
   the Status tab labels the percentage as a hook estimate.
5. A completed lane turn, or a terminal full goal run, writes a durable
   source-attributed lane report into the operator transcript. The server then
   submits that report to the operator harness as an `operator-lane` input so
   it can summarize the outcome and blockers for the user. The report appears
   on the left in its own card; it is never rendered as a human user bubble.
6. Open a lane only when you want its full conversation. Remove it from the
   operator when it no longer belongs to the group. **End operator mode** keeps
   the chat and its history, and removes the links.

## Screen shape

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Chat title                 [Operator]                  [chat | split | tab] │
├──────────────────────────────────┬──────────────────────────────────────────┤
│                                  │ [Status] [Files] [Changes] [Terminal]  │
│  You: Ship the search changes.   ├──────────────────────────────────────────┤
│                                  │ Operator status          End operator  │
│  Operator: I started Codex and   │ 3 lanes · 2 working · 1 needs attention│
│  Claude lanes. I will report     │ ┌──────────────────────────────────────┐ │
│  back on their outcomes.         │ │ ● Search API       Codex · working   │ │
│                                  │ │ Running tool: go build               │ │
│  Report from Search API          │ │ Todo progress              67%        │ │
│  API ready; one blocker...       │ │ ✓ route  ✓ build  ○ review            │ │
│  Operator: Search API is ready…  │ │ Open chat   Remove lane              │ │
│  UI review · failed · Error...   │ └──────────────────────────────────────┘ │
│                                  │ Attach existing chat  [Choose] [Attach]│
│  [Message the operator…]         │ Start a new lane      [Task + harness]│
└──────────────────────────────────┴──────────────────────────────────────────┘
```

## Status contract

The Go-owned chat record is the durable relationship. It stores `operator` and
`operatorLanes`. Linked lane snapshots come from the same chat records the
browser already reads. Their `state`, `lastActivity`, and `lastOutput` are
updated from the SDK sidecar event stream, including Amplifier and ACP harness
events. Native plan tools supply todos; when absent, start, tool, assistant,
and completion events yield a clearly marked estimate. A send receipt proves
only acceptance. The UI never treats it as task completion. A failed or
uncertain lane stays visible and is counted as needing attention. Operator
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

This first version coordinates SDK chats. Terminal panes managed by sessiond
remain in the existing fleet and are not linkable as operator lanes here.
