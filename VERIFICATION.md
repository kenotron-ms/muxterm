# Tracked Tab Indicators - Verification Guide

## What Was Implemented

Added visual treatment to distinguish "tracked" (MCP/agent-driven) tabs from manually-created tabs:

- **Symbol**: ⚡ (U+26A1 HIGH VOLTAGE SIGN)
- **Color**: `--mux-accent` (#7aa2f7 blue)
- **Placement**: Prefix before tab label (after bell indicator if present)

### Implementation Details

1. **Pane Tab Rendering** (`web/src/components/mux-dock.ts`):
   - Added `.mux-tracked-prefix` CSS class styled with `--mux-accent` color
   - Modified `_refreshBellTitles()` to add ⚡ indicator when `pane.clientRef` exists
   - Updated tab rename logic to preserve tracked indicator

2. **Mobile Pane Picker** (`web/src/components/mux-pane-picker.ts`):
   - Added `.tracked-indicator` CSS class
   - Modified pane item rendering to show ⚡ for panes with `clientRef`

## How to Verify

Per AGENTS.md testing policy, this must be verified with actual running muxterm:

```bash
# 1. Build
make build

# 2. Run muxterm
./bin/muxterm &

# 3. Open browser and use playwright-cli to verify
playwright-cli open http://localhost:8311
```

### Test Scenarios

#### Scenario 1: Create tracked pane via MCP
1. Use an MCP client to create a pane (will have `clientRef`)
2. **Expected**: Tab shows ⚡ symbol in blue (#7aa2f7) before the pane name
3. **Expected**: Symbol appears after bell dot (●) if bell is also active

#### Scenario 2: Create manual pane
1. Click the "+" button in the tab bar to create a normal pane
2. **Expected**: Tab shows NO ⚡ symbol (only the pane name)

#### Scenario 3: Mobile pane picker
1. Resize browser to mobile width (< 768px) or use mobile device
2. Tap the pane breadcrumb to open the pane picker
3. **Expected**: Tracked panes show ⚡ symbol in the picker list
4. **Expected**: Manual panes show NO ⚡ symbol

#### Scenario 4: Tab rename preserves indicator
1. Double-click a tracked pane's tab to rename it
2. Enter a new name and press Enter
3. **Expected**: ⚡ symbol still appears before the new name

#### Scenario 5: Bell + Tracked indicator combination
1. Create a tracked pane
2. Trigger a bell event in that pane
3. **Expected**: Tab shows "● ⚡ PaneName" (bell first, then tracked)

### Visual Checklist

- [ ] ⚡ symbol appears in blue (#7aa2f7) color
- [ ] ⚡ symbol appears BEFORE the pane name text
- [ ] ⚡ symbol appears AFTER bell dot (●) when both are present
- [ ] Symbol appears in desktop tab bar
- [ ] Symbol appears in mobile pane picker
- [ ] Symbol persists after tab rename
- [ ] Manual panes have NO ⚡ symbol
- [ ] No console errors in browser devtools

## Cleanup Commands

```bash
# After verification, close browser
playwright-cli close

# Stop muxterm if needed
# (Ctrl+C or kill the process)
```

## Files Modified

- `web/src/components/mux-dock.ts` - Tab rendering + CSS
- `web/src/components/mux-pane-picker.ts` - Mobile picker rendering + CSS
