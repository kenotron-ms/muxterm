# Outcome

A reviewable muxterm product branch has usable Notes and Meetings utility tabs, ad hoc local recording, a two-person video call with screen sharing, and user-controlled recordings and transcripts, demonstrated in Storybook and an isolated real-browser run.

# Exit and evidence

End SHIPPABLE when A-F each pass. End CONCLUDED-BLOCKED if an evidenced technical or external barrier prevents the outcome: name the barrier, preserve the working branch/patch and source data, show the exact unfinished checks, and hand off a feasible next action. A blocked item does not prevent work on independent items. For each A-F, report PASS with observed evidence, FAIL with the unmet check, or BLOCKED with a named reason and residual work. Show evidence in the chat as it is produced; finish with an A-F status table. Never label FAIL or BLOCKED as shipped.

# A. Product surfaces and shared Storybook code

1. Put Notes and Meetings in the existing production utility-pane tab strip. Opening a tab displays its item list immediately, without creating a Page, Note, or Meeting. A selected item opens a viewing/editing surface within that tab; switching tabs preserves the selection and in-progress call or recording.
2. Reuse the production Files tab's list/viewer composition and established tab, row, field, button, status, dialog, and responsive patterns where they fit. Introduce meeting-specific video, recording, and screen-share controls where those patterns have no equivalent. Notes must have an editable surface.
3. Make Storybook render the same production components and state model used by the app. Cover desktop and phone widths for note library/editor, meeting library/details, recorder, call preflight, waiting, active two-person call, screen share, recording, and meeting review. Sample media/call data may be fixtures, visibly identified as samples; production interactions use real state and services.
4. Document the storyboard's state transitions and component reuse decisions. PASS when the browser can navigate the actual tabs and Storybook presents those same component implementations. FAIL/BLOCKED when a named view or shared-code connection is missing; include its location and observed behavior.

# B. Persistent Notes and exact-item MCP access

1. Store Notes as durable chat-linked records with stable ID, title, editable body, created/updated times, and a revision or equivalent concurrency token. List/search notes without creating one; support create, select, edit, and deletion with explicit confirmation.
2. Autosave completed edits and restore them after tab switches, browser reload, and reconnect. Prevent silent overwrites when two editors change the same revision: surface a conflict and preserve both recoverable versions or an explicit merge choice. Show saving, saved, and error state; failed writes keep recoverable local text.
3. Preserve existing Pages IDs and content through migration or a compatibility view, with a documented rollback/recovery path. Existing links to a Page continue to resolve to its content; no silent data loss.
4. Expose MCP operations to list/search, create, read, replace or edit, append, and open a specific Note by stable ID in its owning chat. Mutating content does not steal the browser's current focus; an explicit open request navigates to the Notes tab and exact item. Return useful not-found, conflict, and validation errors.
5. PASS with browser and MCP evidence for persisted edits/reload, legacy Page access, a simultaneous-edit conflict, and opening an exact Note without an extra item. FAIL/BLOCKED with the missing operation or data barrier named; retain all source content.

# C. Meeting library and ad hoc recorder

1. Store durable meeting records linked to the chat: stable ID, title, start/end times, participants when known, and recording/transcript processing states. The Meetings tab opens to a searchable meeting list with details/review and direct Record and Start call actions. Creating a meeting occurs only when one of those actions is chosen.
2. A Record action requests microphone permission, lets the user confirm the input, and starts only after an explicit gesture. Show live recording state, elapsed time, input level or equivalent capture signal, and Stop. Denial or absent input produces a useful state without a false recording.
3. Persist original captured media in muxterm-controlled storage and make finalization explicit. Preserve a recoverable recording if upload/finalization fails. Tab changes and reconnect must not silently stop or discard active recording; the UI reports its actual state after reconnect.
4. Show a completed recording in the meeting library with playable original media. PASS when a real microphone recording plays after a fresh browser connection and library metadata matches it. FAIL/BLOCKED with the lost-media, permission, or storage failure named and remaining source preserved.

# D. Two-person guest video call and screen sharing

1. Provide host preflight for microphone/camera selection and permissions, a short-lived meeting-scoped guest invite, a minimal guest join surface, and a waiting state. The invite grants access only to its meeting and expires or can be revoked. The supported call is one host and one guest.
2. Establish real WebRTC audio/video between two browsers. Provide mic mute, camera off, device/permission feedback, leave/end, and disconnected/reconnecting state. Use muxterm-owned signaling and documented self-hostable STUN/TURN; no third-party meeting service or media relay. Explain network cases needing TURN.
3. Let a participant share a browser-selected tab, window, or display. Put shared content on the main stage while keeping participant video visible; show who is sharing, and allow Stop share without ending the call. Handle share cancellation and browser-ended capture.
4. Recording is a separate explicit action with a visible indicator for both people. Capture active screen share as part of meeting media when recording is on, and state what is included. Tab switching preserves an ongoing call; leaving ends the connection while preserving its meeting record and captured media.
5. PASS with two real browsers showing guest join, bidirectional media, mute/camera changes, screen share and stop, record indicator, tab switch, and clean leave. FAIL/BLOCKED with the missing behavior, invite/security flaw, or network/TURN barrier named; distinguish a Storybook scene from a working call.

# E. Owned transcript and meeting review

1. Keep original media, screen capture, and transcripts in storage controlled by the muxterm operator. Send no meeting content to a third-party meeting or transcription service. Document where data lives, who can access it, retention/deletion behavior, and self-hosted transcription configuration.
2. Run local or self-hosted speech-to-text against the preserved original. Create timestamped segments. Attribute speakers only when separate tracks or other reliable identity evidence supports it; mark uncertain segments unknown. Keep transcript correction separate from original media.
3. Show queued, processing, ready, and failed transcription states. Failure keeps the original playable, exposes an error, and permits retry from that original without duplicating or corrupting the meeting. Do not imply success for a queued or partial result.
4. Pair playback with transcript navigation and editable corrections. Support export of media and transcript, deletion with explicit confirmation, and creation of a linked Note from meeting content. Exported transcript includes timestamps and available speaker labels.
5. PASS with a real recorded meeting whose media plays, transcript can be corrected/exported, linked Note opens, and induced transcription failure can be retried from preserved media. FAIL/BLOCKED with the missing review action, data escape, lost source, or model/storage barrier named.

# F. Verification, safety, and handoff

1. Verify user-visible behavior in a real browser with a real sessiond using isolated `make dev-local` on port 8313 and fresh workspace/pane fixtures. Observe desktop and phone layouts, Notes/MCP flows, recorder, two-browser guest call, screen share, recording, reconnect, and transcript retry. Use Storybook to inspect states, then verify the production flow separately.
2. Run `cd web && npm run check:fast` with zero errors and `go build ./...` successfully. Add no unit tests. Put transient screenshots/logs in `/home/ken/artifacts/` and include observed results and remaining limits in the handoff. Do not claim a feature verified from a mock alone.
3. Never stop/restart/install or mutate the live muxterm, its sessiond, or ports 8311/9090. Use a Digital Twin Universe for install/deploy/service or public-origin paths. If browser automation is unavailable, mark the browser check FAIL/BLOCKED until observed.
4. Prepare a reviewable branch and PR with implementation, design notes, migration/recovery notes, configuration instructions, and verification evidence. If PR creation is refused or unavailable, hand off the branch/patch plus ready PR title/body and the refusal. Before DONE, stop the isolated dev-local stack or explicitly hand its port/process/owner to the user.
5. PASS when checks, observed browser flows, and review handoff are complete. FAIL/BLOCKED with exact check output, missing browser observation, or external refusal and a concrete next action.

# Scope-outs

No production deployment, merge, long-term soak, calendar scheduling, group calls beyond one host and one guest, native mobile app, new unit tests, or third-party transcription/meeting SaaS is required. A responsive phone browser is required. Storybook fixtures alone do not satisfy product behavior.

# Known starting point

A Notes/Meetings storyboard and Storybook concept already exist in a separate clean worktree; the Files story mounts its production component. Treat those as design inputs, not completed product work. The current main checkout has unrelated changes; preserve them. This section is a speed aid, not a substitute for the checks above.
