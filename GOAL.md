# Goal: Status Classification Backend

## Objective
Implement the backend logic to classify muxterm tabs/sessions into three states:
- **Needs Input** — waiting on the user
- **Running** — actively working
- **Completed** — finished

Also add infrastructure to track which tabs are "tracked" (created/manipulated by MCP service, i.e., agent-driven).

## Context
- Issue: kenotron-ms/muxterm#20
- Repository: /project/muxterm-lane1-status-backend
- Branch: feature/status-classification-backend
- This is Lane 1 of a multi-lane implementation managed by goal-batch

## Requirements
1. Define data model for session status (Needs Input / Running / Completed)
2. Implement logic to detect status periodically (not continuously)
3. Add "tracked" flag infrastructure to mark MCP/agent-driven tabs
4. Wire up to existing session/tab data structures
5. Expose status data for consumption by UI components

## Implementation Strategy
- Review existing state management in web/src/state.ts
- Add status classification logic (likely in TypeScript for the web frontend)
- Consider Go backend changes if status needs server-side detection
- Wire up periodic checks (not continuous polling per requirements)

## Acceptance Criteria
- [ ] Status classification logic implemented and working
- [ ] Tracked-tab flag infrastructure added
- [ ] Periodic status check mechanism in place (not continuous polling)
- [ ] Data accessible via existing state management
- [ ] Fast static checks pass (`cd web && npm run check:fast` and `go build ./...`)
- [ ] Feature verified with playwright-cli (per AGENTS.md testing policy)
- [ ] Pre-push review completed successfully
- [ ] Branch pushed to remote
- [ ] PR opened against kenotron-ms/muxterm

## Testing Verification
Per AGENTS.md, this must be verified with actual running muxterm:
```bash
make build
./bin/muxterm &
playwright-cli open http://localhost:8311
# Verify status detection works
playwright-cli close
```

## Critical Reminders
- NO unit tests - use playwright-cli verification (see AGENTS.md)
- Commit early, push immediately after each working change
- Run pre-push-review before pushing
- Fresh fixtures for every verification run
- Kill stale sessiond processes before clean verification

## Dependencies
This is Phase 1 - Lane 2 (monitoring view) and Lane 3 (tracked indicators) depend on this lane's data model.
