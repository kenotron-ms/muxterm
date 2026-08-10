# Mobile Touch Actions — Verification Report

Date: 2026-07-31
Branch: feat/mobile-touch-actions
Dev instance: http://127.0.0.1:8313 (make dev-local, isolated from production 8311)

## Mobile viewport (390x844)

| # | Check | Expected | Actual | Result |
|---|-------|----------|--------|--------|
| 1 | mux-title-bar height | >=44px | 45px rendered (44px CSS height plus 1px bottom border) | PASS |
| 2 | .launcher-btn height | >=44px | 44px | PASS |
| 3 | New-pane button creates real working pane (echo test) | terminal echoes typed text | Created and activated Pane 2; terminal echoed `MTA_TASK4_ECHO` | PASS |
| 4 | Kebab shows "New workspace" at top + divider | present | New workspace was first, followed by a divider; then Settings, Keyboard Shortcuts, Reconnect, About | PASS |
| 5 | New-workspace flow: tap -> modal -> submit -> switch | workspace created & switched | Created and switched to `mobile-task4-185816` (breadcrumb: `mobile-task4-185816 › Pane 0`) | PASS |

## Desktop viewport (1280x800) — regression

| # | Check | Expected | Actual | Result |
|---|-------|----------|--------|--------|
| 6 | mux-sidebar renders, not mux-title-bar | sidebar visible | `mux-sidebar` present; `mux-title-bar` absent | PASS |
| 7 | Dockview tab-strip height unchanged | unaffected by --mux-dock-height | 35px; `--mux-dock-height` was 44px while `--dv-tabs-and-actions-container-height` was 35px | PASS |
| 8 | Sidebar "+ New workspace" still works | workspace created | Created and switched to active workspace `desktop-task4-185841` | PASS |
| 9 | Dockview's own "+" still works | new pane created | Tab strip changed from Pane 1 to Pane 1 and Pane 2 after clicking Dockview's New pane button | PASS |
| 10 | Sidebar kebab shows exactly 4 items, no "New workspace" | Settings/Shortcuts/Reconnect/About only | Exactly 4: Settings, Keyboard Shortcuts, Reconnect, About; no New workspace | PASS |

## Verdict

PASS — all 10 checks green
