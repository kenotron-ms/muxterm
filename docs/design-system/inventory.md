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
| On/off choices and descriptive toggles | New Chat Worktree, chat settings Operator | `mux-ui-switch` | Both toggles now use the shared inline or described-row Switch with native button keyboard semantics. Storybook covers checked, disabled and phone states. |
| Described choices in model and permission pickers | New Chat bundle/model, chat settings permission/model | `mux-ui-choice-item` and shared phone sheet styling | Choice rows migrated, with selected and disabled states in Storybook. The phone panels span the viewport and restore trigger focus on Escape. Picker shells, headings and outside-click handling remain feature-owned. |
| Labelled range controls | New Chat Thinking, chat settings Thinking, Settings font size | `mux-ui-range-field` | All three use the same native input inside the shared element, with semantic token styling, keyboard input, value text, endpoints, disabled state and stacked/inline layouts. Storybook and live New Chat/Settings Chromium verified value changes; chat settings behavior was verified in its API fixture. |
| Navigation selection and keyboard focus | Sidebar, Connections, settings sections, Jobs run history, utility tabs and lists | `mux-ui-nav-item` or the same semantic focus tokens | In progress; Sidebar, Connections, Settings and Jobs history use it, including two-line destinations |
| Terminal pane tabs, split controls and responsive layout | `mux-dock`, Dockview and xterm | semantic dock tokens; integration exception for Dockview DOM | In progress; viewport behavior and tokens migrated, real sessiond review required |
| Chat transcript, composer and goal ledger | `mux-sdk-chat`, `mux-new-chat`, `mux-sdk-chat-settings` | shared actions/feedback and semantic tokens | In progress; main chat has no legacy palette references or literal colors, and its padding, margin, gap, radius and font-size declarations use shared scales. Its goal editor uses the shared adaptive Dialog and Text Area; ledger actions use shared Buttons, Select and Feedback. Message copy/edit/fork actions and edit footer use shared Buttons. Storybook shows active goals, pending proposals, phone goal editor and message editing. Chat still has 21 native controls, including work disclosures, lane report toggles, the auto-sizing composer and file input; feature-specific dimensions and font shorthands need pattern review. New Chat uses shared setup actions, fields, a Worktree Switch, Choice Items and Range Field. Chat settings has zero legacy palette references, literal colors, checked scale declarations and feature-owned native controls; its Operator control uses the shared Switch and its pickers use Choice Items and Range Field. The picker shells remain feature-owned. Folder settings uses the shared adaptive Dialog. Goal and lane control authority remains with the current main API. |
| Chat list project editing, pinned items, and archive | `mux-chat-list` | Dialog, Text Field, Button, semantic tokens and state stories | Project editing and destructive confirmations share the adaptive Dialog, centered on desktop and a sheet on phones. Its stylesheet has no literal palette colors or spacing-scale declarations. Chat rename remains inline; list rows and menus remain feature-owned and need shared-pattern and keyboard review. |
| Connection catalog, setup forms and account states | `mux-connections` | Page Intro, Navigation Item, Select, Button, Text Field, Status Badge and Feedback | Primary navigation now shows only Google, Microsoft and GitHub. Google preview services are nested in a shared Select; Microsoft mail, calendar and files share one account view. Account detail layout remains feature-owned. |
| Settings section navigation, application actions, and remote-host setup | `settings-surface` | Navigation Item section variant, Button, Text Field, Range Field, semantic tokens | Shared controls migrated at desktop and phone widths; stylesheet has no legacy tokens, literal palette colors, or literal spacing-scale declarations. Terminal font size uses the shared Range Field. Theme preview and crayon pickers remain specialized; native radio, checkbox, color, and select controls retain browser form behavior. Voice-mode radio presentation and remaining form patterns need shared review. |
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

The scale ratchet now scans adjacent CSS declarations correctly. Recounting
raised the recorded legacy counts in unchanged Connections, New Chat, Operator
status, chat settings, Sidebar and Skills styles; those numbers are a corrected
inventory, not newly introduced declarations.
