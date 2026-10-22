# Muxterm component library

Muxterm uses Lit custom elements for app chrome and screen composition. Storybook
shows the real elements with isolated API fixtures; the application uses the
same elements with live sessiond data. React is already present for BlockNote,
but moving the whole frontend to React would not itself remove the current UI
seams. The shared components, tokens, review rules, and migration register are
the layer that keeps new screens consistent.

## Run it

From `web/`, run `npm run storybook` and open `http://127.0.0.1:6006`. Use the
Palette toolbar to review dark and light themes and the viewport toolbar to
review phone width. `npm run build:storybook` creates a static catalog in
`web/storybook-static/`.

The Theme Lab stories show how app chrome, controls, menus, and document surfaces
respond to scoped semantic color and backdrop overrides. Change the scheme and
backdrop controls to check a proposed theme at desktop and phone widths. The
component-library pull request workflow uploads the built catalog and a curated
`review-screenshots/index.html` as the `muxterm-component-library` artifact for
reviewers. Those PNGs are generated in CI and stay outside git.

Overlay order is part of the shared contract. Local tokens order content,
screens, drawers, drag overlays, listboxes, menus, window chrome, side panels,
and phone sheets within their feature stacking contexts. App-wide tokens order
toasts, the connection layer, Settings, alerts, and the reconnect overlay. The
Tokens story shows each name and value. Native modal dialogs use the browser
top layer; connection loss closes Settings and workspace creation so the
reconnect notice stays visible and those surfaces stay closed until recovery.
`check:ui` rejects literal `z-index` values in both shared controls and feature
styles so a new surface cannot silently invent its own layer.
The same gate rejects literal palette colors and spacing, radius, or type-scale
declarations in shared control styles. Color Picker's color-value defaults remain
ordinary input data, not presentation styles.

The `Screens/` and `Composites/` stories render production Lit components.
`web/src/stories/api-fixture.ts` replaces their API responses inside the
Storybook frame. Stories can show an error or action state, but they cannot
verify terminal, sessiond, or service behavior. Use the isolated `make dev-local`
instance on port 8313 and a real browser for that verification.

The Page visualization stories render the actual BlockNote React island inside
the Lit catalog. Bar, line, custom document palette, and phone states show how
the chart and editor surface inherit `--ui-document-*` tokens. Chart points
remain native or keyboard-operable buttons, while BlockNote owns editing.

## Rules for new interface work

1. Start with a pattern in Storybook. Add missing states to the shared
   component and its stories before adding a screen-specific treatment.
2. Use `--ui-*` semantic tokens from `web/src/ui/tokens.css` for app surfaces,
   text, controls, spacing, focus, and status. `--mux-*` remains the terminal
   palette; `--chrome-*` remains as a compatibility input during migration.
3. Use the shared Button, Action Tile, Breadcrumb, Action Menu, Menu Item, Tab Strip, Rail Row, List Row, Listbox, Listbox Option, Select Combobox, Folder Browser, Choice Item, Choice List, Choice Picker, Choice Section, Filter Chip, Switch, Radio Group, Theme Choice, Color Picker, Range Field, Dialog, Confirmation, Text Field, Text Area, Select,
   Feedback, Empty State, Page Intro, Navigation Item, and Status Badge where their semantics fit. Keep native controls for
   form submission and browser behavior that a custom element would weaken.
4. Add a story for every new shared Lit element. Show keyboard, focus, busy,
   disabled, error, and narrow-screen states where relevant.
5. Record specialized controls in [the inventory](inventory.md), including the
   reason they cannot use a shared pattern. Dockview, xterm, Monaco, and
   BlockNote retain control of their own rendering surfaces.
6. Verify changed screens in Chromium against dev-local at wide and phone
   widths. Store screenshots under `/home/ken/artifacts/` and share direct
   file links for review; keep image files out of git.

`npm run check:ui` requires stories for shared elements, rejects legacy palette
references in `web/src/ui/`, and checks legacy colors, literal scale values,
and native `button`/`input`/`select`/`textarea` usage in feature components
against `web/scripts/ui-legacy-baseline.json`. Counts must match: a reduction
fails until the baseline is lowered, locking in each migration. If browser
semantics require a new native control, explain it
in the inventory and review the baseline change. The component-library
workflow runs the fast checks and builds Storybook on frontend changes.

## Current scope

Storybook includes foundations and stateful examples for chat, terminal dock,
navigation, Settings, Connections, Skills, Jobs, utility, PDF and image preview,
microphone, and Browser Assistant. Main's current chat uses a goal ledger and
operator lane controls; the catalog follows those current APIs. The interface
is still migrating: `check:ui` is a ratchet, not a claim that every feature
stylesheet is fully tokenized. See [the inventory](inventory.md) for the open
seams and the source of truth for each screen.

The app shell uses the same semantic surface, text, focus, spacing and shadow tokens as the component library. Workspace creation uses a shared adaptive Dialog, Text Field and Buttons through `mux-workspace-create-dialog`; Storybook records desktop, phone, busy and light states. A shared Sidebar Button now opens that dialog from desktop chrome or the phone navigation drawer, without a local/remote choice. Storybook catalogs the entry and dialog together. Isolated Chromium created fresh sessiond workspaces from both visible paths without horizontal overflow. The shell owns workspace creation through sessiond.

The Sidebar's active chrome and spacing now use semantic tokens. Destinations and Settings use the same Navigation Item, with the version shown as Settings detail; the footer's New workspace action uses the shared Button. The phone drawer omits the brand row already present in the mobile title bar. Storybook records reachable destinations, the creation action and dialog, phone and light states. The unreachable workspace chooser, workspace preview and machine-group code was removed.

Destructive pane and workspace close uses the same adaptive Dialog and semantic tokens. Its risk summary is the dialog's accessible description, Cancel receives initial focus, and an in-flight confirmation blocks dismissal. Sessiond alone decides whether the close requires confirmation and when a pane or workspace actually disappears. Storybook records pane, workspace, multi-risk, phone, busy and light states; a real dev-local pane verified the close path.

Connections uses the shared Confirmation composite for GitHub disable, Microsoft disconnect, old Work IQ authorization removal, and Google connection removal. Its three provider destinations stay visible while each provider owns its setup details. Google's manual setup is a sequence of divided sections instead of nested cards, and Connections spacing uses semantic scales. Storybook shows account and confirmation states at desktop and phone widths. The isolated live app rendered all three providers at both widths without horizontal overflow; authentication and destructive API calls were not exercised there.

Skills uses semantic page, surface, border, type and spacing tokens throughout. Storybook records search results, install success, empty results, load errors, recovery, phone and light states. A failed installed-list request now shows a readable error with Retry instead of a misleading empty-library message; the fixture's Retry action reloads the installed list.

## Main-based browser evidence

Chromium verification uses Storybook for populated UI fixtures and isolated
`make dev-local` on port 8313 for the real app and sessiond. Review screenshots
live under `/home/ken/artifacts/`, outside the repository. The source stories
and the notes below identify the states that were inspected.

New Chat uses shared setup actions, fields, harness Select, Feedback and semantic
colors. Its location editor uses the adaptive Dialog: a centered desktop modal
and a phone bottom sheet. In dev-local Chromium, the folder browser opened,
harness selection updated model choices, and Escape dismissed the phone sheet.
A shared Switch now presents the project Worktree choice. Storybook shows it
enabled with a selected project at desktop and phone widths; Chromium toggled
it off and confirmed its checked state changed. The isolated live New Chat
correctly disables the switch until a project is selected.
A live New project editor opened with name and folder fields. Clicking the
shared attachment button opened the browser file chooser. The isolated app had
no project and rejected automated fixture creation under its human-browser
authority boundary, so live project save awaits an authorized fixture.
New Chat now uses semantic scale tokens throughout its checked stylesheet. Its
attachment removal action uses the shared Button; on coarse pointers, the small
icon action has a 44 px target. Storybook catalogs ready attachments at desktop
and phone widths. In isolated Chromium, a text file reached Ready and was
removed, the phone location dialog opened, and the 390 px page had no horizontal
overflow. Screenshots for these checks remain outside git.

The chat project editor uses shared Text Field, Button and Dialog controls with
semantic colors. Project renaming opens the same editor as folder changes;
Storybook verified that saving a name updates the row. Chat renaming stays
inline. Removing a project and archiving a linked lane now open the adaptive
Dialog for review before changing data. Storybook verified that Cancel and
Escape keep the project, while confirmation removes it and moves its chats to
Ungrouped. The Archived story uses two chats from the current main API shape.
Project, chat and move actions now use the shared Action Menu and Menu Item.
The item keeps native button or link semantics while the menu coordinates
arrow, Home/End, Escape and Tab behavior; Escape restores the feature trigger.
Chromium inspected the migrated Chat List
and Utility menus at desktop and phone widths in Storybook, including named
menu items, keyboard navigation, focus restoration, and native link attributes.
The isolated dev-local app and sessiond passed a fresh-workspace smoke check;
the current menu migration was exercised against Storybook's screen fixtures.
The chat list's eight repeated project, chat and pinned icon actions now use
the shared Button. Menu triggers expose `aria-haspopup` and `aria-expanded`
through its native inner button. On phones, project and chat options remain
visible without hover, while their secondary actions live in the menu; the
Ungrouped new-chat action and pinned unpin actions also stay visible. Storybook
verified the phone project sheet and Escape focus restoration, and touch
emulation measured a 44 px target. Screenshots remain outside git.

Project disclosure, chat destinations and pinned entries now use the shared
List Row. Its native inner button owns focus, selected and expanded semantics;
the chat list keeps its actions and chat routing. Storybook catalogs group,
selected, pinned, archived, focus, light and phone states. In a fresh dev-local
workspace, Chromium expanded Ungrouped by click and Enter, opened a real chat,
and saw `aria-current` follow the selected row. Touch-enabled Chromium measured
44 px project, Archived and options targets with no horizontal overflow.

Connections has three primary destinations: Google, Microsoft and GitHub.
Google preview services sit inside its provider view; Microsoft mail, calendar
and files share one account view. Storybook covers both provider layouts and a
synthetic Microsoft sign-in state. Dev-local Chromium verified all three
primary destinations, provider navigation at desktop and phone widths, and no
horizontal overflow.

Settings uses shared section Navigation Item, Button, Text Field, Range Field,
Radio Group, Switch, Select, Theme Choice and Color Picker controls with semantic tokens. One native Radio
Group now owns font family, terminal bell and voice sign-in choices; the voice
enable control uses Switch and the Entra scope uses Select. Storybook and live
dev-local Chromium verified selection, keyboard navigation, the font preview,
phone layout and scope changes. Theme Choice receives the actual terminal
palette colors as data and can preview an optional backdrop; Color Picker owns
named presets, accessible 44 px swatches, the native custom-color input and
reset. Settings keeps theme persistence and picks dark or light presets from
the current palette. Storybook verified both palette families, custom color
selection, reset and a 390 px light theme. The Settings native-control baseline
fell from 10 to 0. Dev-local also verified all eight destinations, phone
navigation visibility, Workspaces and About controls, without starting an
update.

Scheduled Jobs uses shared form fields, Dialog, Button, Navigation Item, Page
Intro, Status Badge and Feedback. Storybook covers populated rows, failed run
history and the new-job editor. Dev-local Chromium opened the empty Jobs screen
and phone editor, dismissed it with Escape, and followed “Start a new chat for
this job.” No job was created or run; populated rows use synthetic data.

Operator status uses shared Filter Chip, Status Badge, Button and Feedback.
Its lane disclosure uses Button's expanded and controlled-panel semantics.
Storybook covers desktop and phone progress, expanded lane actions and an error
state without stale loading. Chromium verified Enter disclosure and panel
linkage at both widths. The live dev-local Status tab displayed a regular
chat's task progress; populated operator lanes require an operator fixture.
Lane progress and closure authority remain with the real operator and sessiond.

Main chat now uses semantic palette tokens throughout its transcript and goal
ledger. The goal editor uses the shared adaptive Dialog, Text Area and Buttons;
ledger actions use shared Buttons, Select and Feedback. Storybook shows an
active goal, a pending proposal with separate approval actions, and the phone
editor as a bottom sheet. Chromium confirmed the phone sheet accepts edits,
Escape dismisses it, and the desktop transcript still shows work details.
The chat stylesheet also uses shared spacing, radius and typography scales,
and message copy/edit/fork actions plus the edit footer use shared Buttons.
The Message Edit story shows the editor at desktop and phone widths; Chromium
confirmed Cancel closes it without horizontal overflow. A light palette story
confirmed the semantic surfaces resolve to the selected theme.
The chat header and composer now use shared Buttons for goal and utility
controls, attachment, send or stop, steering, retry and scroll-to-bottom. The
goal and utility controls expose expanded and pressed state through their
inner buttons. Storybook catalogs desktop drafts, phone drafts, running turns,
attachments, voice speaking and the chat embedded under the phone shell.
Touch-enabled Chromium measured send, stop, attachment removal and voice stop
controls at 44 px without horizontal overflow. In a fresh dev-local workspace,
Chromium opened the real chat's goal ledger and utility pane, attached and
removed a file without sending a message, and checked the phone composer.
Initial history loading, connection errors and goal-command notices now use
shared Feedback. Error messages have alert semantics; a failed connection
keeps Retry, and a successful read-only `/goal` inspection has status
semantics. Storybook covers loading, desktop and phone failures, command
notices and recovery to real fixture messages.
In a fresh dev-local workspace, Chromium failed seven browser-only history
requests to reach the real reconnect state, then Retry loaded the chat
transcript. A read-only `/goal` command displayed the shared status notice.
The phone Retry target measured 44 px with no horizontal overflow.
The narrow shell supplies the chat title once; the inner chat row keeps its
actions.
Delegated work now uses Action Tile with a visible Status Badge and an
accessible status name. Agent ancestry uses Breadcrumb, so each ancestor is
keyboard navigable. Linked lane reports and cross-chat messages use shared
Buttons for disclosure and source navigation; the Button carries expanded
and controlled-panel semantics. Storybook includes delegated, open-delegated,
linked-report and phone states. Chromium checked expansion, return navigation,
and 44 px source actions in a touch-enabled phone viewport.
These stories use synthetic read-only goal data and do not exercise live goal
control. The auto-sizing composer and hidden file input keep native editor
semantics, as recorded in the inventory.

Utility's Open file actions use the same Action Menu and Menu Item, including its separator,
keyboard path and phone sheet. Storybook's actual Utility screen showed the
file menu at desktop and phone widths; Chromium confirmed End reaches Close file
and Escape restores focus to Open. Its Storybook fixture supplies the preview
file, so file-launch actions were not exercised against a live filesystem.
The Utility viewer and explorer toolbar now use shared Buttons for ten repeated
actions: close, back, ask, source/preview, browser toggle, Open menu, file
search/refresh/collapse, and new page. The Button owns toggle and menu ARIA
state, while the screen owns the action handlers. Browser review found that
small text-and-icon Buttons were only 28 px tall under touch emulation; the
shared coarse-pointer rule now raises them to 44 px. The phone file header and
explorer toolbar fit without horizontal overflow.
The Pages editor now uses the Button's document appearance for its list toggle,
parent breadcrumb, delete action, new subpage action and empty-state action.
`--ui-document-*` tokens keep paper controls separate from app chrome and
include a document accent that themes can override. Storybook catalogs these
tokens and the populated, empty, nested, phone and delete-confirmation page
states. On narrow nested pages, the idle Saved label gives space to the
breadcrumb; Saving remains visible. Icon-only Buttons do not shrink below
their shared touch target when a breadcrumb is long. The title field and
BlockNote content retain native editing semantics.
The New tab tool chooser now uses the shared Action Tile for Files, Status,
Changes and New page. Each tile gives the action a short name and a useful
description, while its native button keeps keyboard behavior. Storybook
catalogs the default, focused, disabled, phone and light states. The live
chooser used a single column on a 390 px phone, with four 58 px touch targets
and no horizontal overflow; all four actions opened their expected tools in a
real chat. The tool names and descriptions stay with the screen, while the
surface and interaction states belong to the shared element.

File and page ancestry now use the shared Breadcrumb, with theme-aware app and
document appearances. It owns the path structure, current-location label,
ancestor button sizing and narrow-width overflow; each screen handles the
navigation event. In Files, choosing an ancestor opens the explorer if needed
and focuses that folder, making the action visible while keeping the file
preview open. The explorer root is now a shared Rail Row inside the tree, so
its level, expanded state and Arrow navigation follow the same pattern as
child folders. Storybook shows nested paths, hidden browser, empty, phone,
document and light states; the live nested file path was reviewed in a real
chat.

The shared Switch also replaces the bespoke Operator toggle in chat settings.
It has inline and described-row layouts, checked and disabled stories, native
button keyboard behavior, and semantic theme colors. Chromium confirmed click
and Space activation in the standalone story, plus the Operator row in desktop,
phone and light-theme chat settings. The New Chat and chat settings pickers now
use the same Choice Item for selected, disabled, and described options. Both
screens use the shared Choice Picker, which owns desktop placement,
outside-click and Escape behavior, sibling-picker coordination, and a
full-width bottom sheet presentation. Choice Section now gives provider, model,
permission, mode and operator groups the same heading, divider and note layout,
with an accessible group label when a heading exists. Choice List now owns the
bounded model scroll region in both screens, and compact Feedback presents
loading, empty and error states with the same status semantics. Chat settings
can retry a failed initial load. Chromium verified model selection and Escape
focus restoration in the isolated live New Chat, plus scrollable model lists
at desktop and phone widths in Storybook and the isolated app. Storybook also
shows a recovered chat-settings load.
The same Range Field now owns the native Thinking effort sliders in both chat
screens and terminal font size in Settings. Chromium checked keyboard value
changes in Storybook and in the isolated live New Chat and Settings screens;
the live font-size change was restored after verification.

New Chat's project selection and the chat command suggestions now use shared
Listbox and Listbox Option elements. Select Combobox also owns the project
trigger and its keyboard behavior. The shared rows own selected, active,
description and icon presentation; the shared surface places project choices as
a desktop popover or phone sheet and command suggestions above the composer.
The select-only project combobox keeps DOM focus while Arrow keys change the
active option, Enter commits the choice, and Escape dismisses the sheet. Its
trigger and options share a shadow root, so the ARIA references resolve. The
chat textarea keeps focus while Arrow keys move through suggestions; Enter
inserts a command without sending it. Both controls reference active options with
`aria-activedescendant`, following the [WAI-ARIA listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/)
and [combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).
Chromium checked desktop and phone Storybook states and both controls in
isolated dev-local; command execution was not part of this pass.

New Chat's location editor and the project editor use one Folder Browser for
parent navigation, subfolders, and choosing a path. The optional new-folder
field only proposes a path; it does not create a directory. Navigation in New
Chat leaves the chosen path unchanged until the user selects a folder. Storybook
contains populated, empty, project-editor, phone, and light-theme states.
The New Chat location trigger uses the shared Button. It exposes the full path
as its accessible name, announces dialog popup state, and regains focus after
Done, Close, or Escape. Storybook covers ungrouped and project locations on
desktop and phone; the project fixture passes the selected project's folder as
the app does. The two remaining native New Chat controls are its auto-sizing
composer and hidden file input.

HTML previews now use the shared Button for Run preview while preserving the
iframe script gate. Storybook shows static and running states at desktop and
phone widths; isolated Chromium opened a real HTML file, checked the sandbox
change after the click, and measured a 44 px phone target. External scripts in
the real project file remain blocked by the preview policy.

The Utility panel uses semantic tokens for chrome and document colors, plus
shared compact Text Field and Select controls in the file rail. Storybook's
Utility stories cover the file viewer at desktop and phone widths, its light
theme, the Changes diff, Pages, page deletion and Quick Open. Monaco owns the
diff editor. The phone page list leaves more room for the editor; page deletion
and Quick Open use the adaptive Dialog for desktop modals and phone bottom
sheets.
The shared Tab Strip now presents Utility's Files, Status, Changes and Pages.
It owns roving focus, arrow/Home/End selection, Delete and close actions, and
scrolls the selected tab into view in an overflowed phone row. Utility still
owns each panel's data and the saved tab list. Storybook catalogs selected,
overflowed, phone and light states. In isolated dev-local Chromium, a fresh
chat opened Files, added a tab, selected Changes, and closed it at phone width;
focus returned to Files. The phone page had no horizontal overflow. Review
screenshots remain outside git.
File, touched-file, change and page rails now use one shared Rail Row. It owns
indentation, selected and focus styling, icon, optional detail and native
button activation; the file tree still owns cross-row Arrow navigation. In a
fresh dev-local chat, Chromium expanded a folder, focused a nested file with
ArrowDown, opened its preview, selected a changed file, and created a page and
subpage at phone width. The phone page had no horizontal overflow. Storybook
catalogs the row in file, change, page, phone and light states.

In isolated dev-local Chromium, a fresh terminal pane and real sessiond showed
the filtered file explorer and Quick Open phone sheet. The shared file filter
narrowed the real tree, and Storybook accepted a new sort selection. Quick Open
searched real files; Enter opened a Storybook file result and one Escape
closed a filled live search. Pages and Changes use synthetic Storybook data
because the isolated app had no chat.

Quick Open now uses the shared Command Search inside the adaptive Dialog. The
component owns the editable combobox, embedded result listbox, active option,
Arrow navigation, Enter selection, Escape dismissal and status messages.
Utility continues to fetch matching files and open the chosen path. Storybook
shows results, loading, no results, errors, truncation and a phone sheet; the
file welcome action uses the shared Button. The Utility inventory now counts
one feature-owned native control, down from 39 at the start of this pass.
The page title remains a native inline editor.
File-viewer loading, empty, oversized and error states use shared Feedback.
Failures offer Retry; Storybook includes file and raw-preview recovery states.
The full-panel Files welcome view, Changes selection view, and Pages empty and
unavailable views now use shared Empty State with icon, heading, description,
optional action, and app or document palettes. Diff loading, oversized and
binary states use Feedback. A failed diff request now shows an error with Retry
instead of reporting a binary file; Storybook records error and recovery.
In isolated dev-local Chromium, the Files Empty State opened Quick Open, the
Changes Empty State appeared before selection, and failed real diff requests
recovered after Retry at desktop and phone widths. The phone action targets
measured 44 px without page overflow.
The Files, Changes and Pages rails now use the same Feedback for empty,
loading, warning and failed-load states. Their failed requests offer Retry;
Storybook records those failures and successful recovery at desktop and phone
widths. A failed Pages save retains the current editor content and reports the
error without offering a reload that could discard edits.
In isolated dev-local Chromium, fresh sessiond workspaces and a real chat
recovered from failed Files and Changes requests, and a restored Pages tab
recovered from a failed initial load. At phone width, Changes Retry measured
44 px and the page had no horizontal overflow.
Chromium returned one synthetic raw-file failure to the isolated live browser,
then let Retry reach the real dev-local server. The preview recovered at desktop
and phone widths; the phone Retry target measured 44 px without page overflow.

The mobile pane picker uses the native Popover API for its bounded phone sheet.
Storybook now renders its own fixture store, including nine-pane scrolling,
attention marks, long names and a close intent that leaves the pane present.
Chromium checked the handoff at 767/768 px: the picker is available below 768 px
and Dockview tabs appear at 768 px. In a fresh dev-local workspace, the phone
sheet created two real panes and selected another. Closing a pane with a
running command opened the adaptive confirmation sheet; Cancel kept it and
confirmation removed it after sessiond responded. Screenshots are stored
outside git.
