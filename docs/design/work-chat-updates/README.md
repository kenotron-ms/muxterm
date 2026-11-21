# Work updates in chat: design review

This is a design round for Work `ad3555425a365ed3b29ded090cfac618`. It changes no production chat or Work code. Open [the interactive mockup](mockup.html) in a browser and use the two concept buttons. Each Work action opens a sample Work detail drawer; `?concept=b&item=inspection` opens the attention example directly.

## Current behavior inspected

- `internal/server/sdk_work.go` emits `work.attention` for claims, completion, review, blockers, and decisions, using copy such as “Work claimed: … Open the Work tab for details.” `sdk_work_start.go` emits “Work kickoff needs inspection: …” after an uncertain or failed kickoff; `sdk_work_scheduler.go` emits “Work needs inspection: …” when a worker stops unexpectedly.
- The event includes `WorkID`, but `mux-sdk-chat.ts` currently builds `work.attention` as a plain `status` block without `workId`. Its `View work` control and `openWorkItem()` route only appear when a block retains `workId`. Goal proposals do retain it and show `View work` plus `mux-work-goal-review`.
- `mux-chat-coordination.ts` already shows the Work detail with status, next move or blocker, progress, outcome, worker chat, recent activity, and goal review. The mockup actions lead to that existing kind of detail, rather than inventing a second decision surface in chat.

The examples use realistic Work data from this project's current records: an archived-session eligibility claim, a completed mobile Files design, and an uncertain fresh-worker kickoff. They are illustrative copies, not a claim that those records currently have the shown states.

## Concepts

| | A: In-thread updates | B: Work digest |
|---|---|---|
| Structure | One update at each event position; informational states use a narrow rule, while inspection gets a stronger panel. | A single grouped activity block ordered by urgency, with an attention count and one row per Work item. |
| Clarity | Status, item, worker or outcome, and contextual action are visible without opening Work. Chronology is easy to follow. | Attention is first; all three states are comparable at a glance. Worker and outcome copy remains short. |
| Interruption | Good for rare updates; repeated claims and completions lengthen the transcript. | Lower repeat noise when several items move together; the block itself takes more visual weight. |
| Discoverability | Every event is visible at its arrival point, but older actions move up the thread. | A stable summary is easier to find if it updates in place; the first Work event must create it in a visible position. |
| Fit with chat and Work | Feels like a native status row in the chat stream. | Feels like a compact Work view embedded in chat; each action opens the full Work record. |

**Recommendation: Concept B.** The user's complaint is repeated, context-poor notices. A single digest makes multiple simultaneous Work items scannable while keeping ordinary chat messages on either side. Keep only the latest meaningful state per Work item; update its row in place, with an explicit attention count and attention row first. Do not append a new digest for every event. Concept A is simpler and preserves chronology, but its vertical cost grows with each item and status change. Concept B's tradeoff is that the grouped block is more visually prominent and its original place in the transcript must stay discoverable as the chat grows; a small “Work from this chat” navigation target could help if later user review confirms that need.

The colored states never rely on color alone: each includes a text status and distinct wording. All action controls are at least 44px high, remain visible at 320px, and have visible keyboard focus. On phones, the Work detail opens as a full-width sheet with an explicit 44px close control; closing returns focus to the action. The proposed production interaction should also trap focus inside the open sheet and announce its title to assistive technology. The mockup is a review artifact and does not submit real Work actions.

## Browser captures

All images were rendered in Chrome from `mockup.html`, with full-page captures at 1440px, 390px, and 320px. The 320px detail capture demonstrates the action destination.

| Concept | Desktop | 390px phone | 320px phone |
|---|---|---|---|
| A | [Desktop](concept-a-desktop.png) | [390px](concept-a-phone-390.png) | [320px](concept-a-phone-320.png) |
| B | [Desktop](concept-b-desktop.png) | [390px](concept-b-phone-390.png) | [320px](concept-b-phone-320.png) |

[Concept B: inspection detail at 320px](inspection-detail-phone-320.png)
