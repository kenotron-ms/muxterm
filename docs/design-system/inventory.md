# Interface inventory

This register names the repeated UI treatments found in the current
`origin/main` frontend. “In progress” means the shared pattern exists and some
real uses have moved; the remaining uses still need migration and browser
review. Storybook is the state catalog, while the live app is the behavior
source of truth.

| Pattern | Current location | Shared destination | State |
| --- | --- | --- | --- |
| Action sizes, emphasis, busy and destructive colors | Chat, New Chat, Skills, Jobs, Settings, Connections, Browser Assistant | `mux-ui-button` | In progress; Connections, Browser Assistant, Skills, Jobs row/editor actions and the chat project editor use it |
| Labels, search fields and errors | Chat list, Skills, Settings, utility, Connections, Jobs | `mux-ui-text-field`, `mux-ui-text-area`, `mux-ui-select` and native form controls | In progress; Jobs search, filter and editor now use the shared fields; Connections setup forms, the chat project editor, Skills and selected settings controls use Text Field |
| Modal width, backdrop and dismissal | Settings, Connect machine, close confirmation, Job editor, project editor, utility Quick Open | `mux-ui-dialog` | In progress; Settings, Connect machine, Jobs editor, project editor and Quick Open use the shell. Adaptive presentation centers on desktop and opens as a bottom sheet on phones. |
| Empty, loading, error and recovery messages | Skills, Jobs, chat, Browser Assistant, image/PDF preview | `mux-ui-feedback` | In progress; major screens have adopted it |
| Page title, eyebrow, subtitle and action | Skills, Jobs, Connections | `mux-ui-page-intro` | Migrated on Skills, Jobs and Connections; other screens still have feature titles |
| Status labels and attention | Connections, Jobs, operator lanes, dock and sidebar | `mux-ui-status-badge` | In progress; Connections, Jobs, and operator lanes use it |
| Counted filter choices | Operator lanes and other result lists | `mux-ui-filter-chip` | Operator lanes migrated; the native button inside the chip owns keyboard and pressed semantics |
| Navigation selection and keyboard focus | Sidebar, Connections, settings sections, Jobs run history, utility tabs and lists | `mux-ui-nav-item` or the same semantic focus tokens | In progress; Sidebar, Connections, Settings and Jobs history use it, including two-line destinations |
| Terminal pane tabs, split controls and responsive layout | `mux-dock`, Dockview and xterm | semantic dock tokens; integration exception for Dockview DOM | In progress; viewport behavior and tokens migrated, real sessiond review required |
| Chat transcript, composer and goal ledger | `mux-sdk-chat`, `mux-new-chat`, `mux-sdk-chat-settings` | shared actions/feedback and semantic tokens | In progress; New Chat now uses semantic color tokens, shared setup actions, fields, harness select and error feedback. Folder settings use the shared adaptive Dialog: centered on desktop and a bottom sheet on phones. Its auto-sizing message textarea, file input, model effort slider, project/folder menu triggers and worktree switch keep native controls for their specialized interactions. Main's goal ledger and lane interactions must stay authoritative. |
| Chat list project editing, pinned items, and archive | `mux-chat-list` | Dialog, Text Field, Button, semantic tokens and state stories | Project editing and destructive confirmations share the adaptive Dialog, centered on desktop and a sheet on phones. Its stylesheet has no literal palette colors or spacing-scale declarations. Chat rename remains inline; list rows and menus remain feature-owned and need shared-pattern and keyboard review. |
| Connection catalog, setup forms and account states | `mux-connections` | Page Intro, Navigation Item, Select, Button, Text Field, Status Badge and Feedback | Primary navigation now shows only Google, Microsoft and GitHub. Google preview services are nested in a shared Select; Microsoft mail, calendar and files share one account view. Account detail layout remains feature-owned. |
| Settings section navigation, application actions, and remote-host setup | `settings-surface` | Navigation Item section variant, Button, Text Field, semantic tokens | Shared controls migrated at desktop and phone widths; stylesheet has no legacy tokens, literal palette colors, or literal spacing-scale declarations. Theme preview and crayon pickers remain specialized; native radio, range, checkbox, color, and select controls retain browser form behavior. Voice-mode radio presentation and remaining form patterns need shared review. |
| Scheduled Jobs list, filters, run history and editor | `mux-scheduled-jobs` | Page Intro, Status Badge, Button, Navigation Item, Dialog, Text Field, Text Area, Select, Feedback | Shared controls and semantic tokens migrated; native Enable schedule checkbox remains for browser semantics. Job table, summary values and run log retain data-specific layout. Storybook catalogs populated, empty, new/edit editor and failed-history states; live dev-local verified its empty state and editor path. |
| Operator lane status, filters, and actions | `mux-operator-status` | Filter Chip, Status Badge, Button, Feedback, semantic tokens | Shared treatments migrated; the lane expansion button stays native inside the table for its `aria-expanded` and `aria-controls` semantics. Progress bars and lane details retain data-specific layout. |
| Document and source viewers | `mux-sdk-utility`, PDF, Monaco and BlockNote | semantic document/media tokens, compact Text Field and Select, adaptive Dialog; integration exception for owned DOM | Utility's stylesheet now uses only semantic color and spacing tokens. The file rail uses shared compact search and sort controls. Quick Open uses the shared Dialog; page deletion opens the same desktop modal and phone sheet pattern. Tree rows, tabs, menus, inline page title and content editing retain native semantics; their repeated treatments still need shared-pattern review. Monaco and BlockNote own their editor surfaces. |
| Browser pairing and connection actions | `mux-browser-assistant` | Button and Feedback | Migrated; story states cover unpaired, paired and unavailable service |

## Catalog coverage

The catalog has stories for the shared UI elements and the primary current
screen components. `mux-app` has no standalone Storybook story because it owns
the live WebSocket/sessiond lifecycle; its constituent screens have stories and
the app shell must be reviewed in dev-local. `mux-browser-assistant` is included
because it is a screen introduced on main after the earlier catalog branch.

`launcher-menu.ts` and `mux-connect-dialog.ts` still exist on main, but current
title-bar and sidebar navigation do not mount the launcher. The Connect machine
story demonstrates the component, not a reachable path in today's app. Remote
host actions are available in Settings → Remotes. Remove or reconnect these
orphaned elements in a focused product change before claiming live coverage.

## Review record

The catalog and baseline are rooted in `origin/main` at `c0c5f2e5`. The prior
worktree's screenshots are excluded because they showed an older branch and
obsolete navigation. Browser and dev-local evidence for this revision should
be attached to the change review, using screenshots taken from this worktree.
