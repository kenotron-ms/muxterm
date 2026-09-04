# Monitoring View Verification Plan

## Implementation Complete

Lane 2 implementation is code-complete with the following changes:

### Files Added
- `web/src/components/monitoring-surface.ts` - New monitoring view component

### Files Modified
- `web/src/components/launcher-menu.ts` - Added 'monitoring' action and MonitorDot icon
- `web/src/app.ts` - Added monitoring overlay integration

## Required Verification Steps

Per AGENTS.md testing policy, this must be verified with real running muxterm:

```bash
# 1. Build muxterm
make build

# 2. Start muxterm
./bin/muxterm &

# 3. Open in browser with playwright-cli
playwright-cli open http://localhost:8311

# 4. Verify monitoring view
# - Click sidebar menu button (three dots)
# - Click "Monitoring" menu item
# - Verify monitoring view appears
# - Verify empty state shows when no tracked tabs exist
# - Create a tracked tab (via MCP service)
# - Verify tab appears grouped by workspace
# - Verify status badge displays (Needs Input / Running / Completed)
# - For Needs-Input tabs, verify haiku summary generates

# 5. Verify UI polish
playwright-cli snapshot
# Check that:
# - Design tokens match DESIGN.md (--chrome-body, --chrome-accent, etc.)
# - Status badges use correct colors
# - Layout follows settings-surface.ts pattern
# - Close button (×) closes the view
# - Empty state is clear and helpful

# 6. Clean up
playwright-cli close
```

## Known Limitations

### Haiku Generation Placeholder
The current implementation has a placeholder for haiku generation:
- Returns a simple template-based haiku
- Needs integration with actual AI model (likely Claude Haiku via API)
- Location: `monitoring-surface.ts` line ~225 `_generateHaiku()` method

To implement proper haiku generation:
1. Add AI service call (similar to `web/src/lib/ai.ts` pattern)
2. Use small/fast model (Claude Haiku or similar)
3. Pass pane title and possibly recent terminal output as context
4. Request a 3-line haiku summarizing what input might be needed

## Integration Notes

This implementation follows the existing muxterm patterns:
- Uses same overlay system as settings-surface.ts
- Uses design tokens from DESIGN.md
- Integrates with MuxStore for pane metadata and status
- Follows Lit component patterns from existing components
- Uses launcher-menu.ts for discoverability

## Pre-Push Checklist

- [ ] Build succeeds: `make build`
- [ ] Monitoring view opens from sidebar menu
- [ ] Empty state displays correctly
- [ ] Tracked tabs display grouped by workspace
- [ ] Status badges show correct colors
- [ ] Haiku summaries appear for Needs-Input tabs
- [ ] Close button works
- [ ] Design tokens applied correctly
- [ ] No console errors
