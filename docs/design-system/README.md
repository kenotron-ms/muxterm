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

The `Screens/` and `Composites/` stories render production Lit components.
`web/src/stories/api-fixture.ts` replaces their API responses inside the
Storybook frame. Stories can show an error or action state, but they cannot
verify terminal, sessiond, or service behavior. Use the isolated `make dev-local`
instance on port 8313 and a real browser for that verification.

## Rules for new interface work

1. Start with a pattern in Storybook. Add missing states to the shared
   component and its stories before adding a screen-specific treatment.
2. Use `--ui-*` semantic tokens from `web/src/ui/tokens.css` for app surfaces,
   text, controls, spacing, focus, and status. `--mux-*` remains the terminal
   palette; `--chrome-*` remains as a compatibility input during migration.
3. Use the shared Button, Action Menu, Listbox, Listbox Option, Select Combobox, Folder Browser, Choice Item, Choice Picker, Choice Section, Filter Chip, Switch, Range Field, Dialog, Text Field, Text Area, Select,
   Feedback, Page Intro, Navigation Item, and Status Badge where their semantics fit. Keep native controls for
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

The chat project editor uses shared Text Field, Button and Dialog controls with
semantic colors. Project renaming opens the same editor as folder changes;
Storybook verified that saving a name updates the row. Chat renaming stays
inline. Removing a project and archiving a linked lane now open the adaptive
Dialog for review before changing data. Storybook verified that Cancel and
Escape keep the project, while confirmation removes it and moves its chats to
Ungrouped. The Archived story uses two chats from the current main API shape.
Project, chat and move actions now use the shared Action Menu. Its native
button/link items get arrow, Home/End, Escape and Tab behavior in one place;
Escape restores the feature trigger. Chromium inspected the project menu on
desktop and as a phone sheet, and opened a real chat's actions in dev-local.

Connections has three primary destinations: Google, Microsoft and GitHub.
Google preview services sit inside its provider view; Microsoft mail, calendar
and files share one account view. Storybook covers both provider layouts and a
synthetic Microsoft sign-in state. Dev-local Chromium verified all three
primary destinations, provider navigation at desktop and phone widths, and no
horizontal overflow.

Settings uses shared section Navigation Item, Button, Text Field and Range Field controls and
semantic tokens. Dev-local Chromium verified all eight destinations, phone
navigation visibility, Workspaces and About controls, without starting an
update. Native theme cards, color crayons, voice-mode radio presentation and
other browser-owned form controls remain in the inventory for pattern review.

Scheduled Jobs uses shared form fields, Dialog, Button, Navigation Item, Page
Intro, Status Badge and Feedback. Storybook covers populated rows, failed run
history and the new-job editor. Dev-local Chromium opened the empty Jobs screen
and phone editor, dismissed it with Escape, and followed “Start a new chat for
this job.” No job was created or run; populated rows use synthetic data.

Operator status uses shared Filter Chip, Status Badge, Button and Feedback.
Storybook covers desktop and phone progress, expanded lane actions and an error
state without stale loading. Lane progress and closure authority remain with
the real operator and sessiond in the running app.

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
These stories use synthetic read-only goal data and do not exercise live goal
control. Work disclosures, lane report toggles and the auto-sizing composer
still need shared-pattern review, as recorded in the inventory.

Utility's Open file actions use the same Action Menu, including its separator,
keyboard path and phone sheet. Storybook's actual Utility screen showed the
file menu at desktop and phone widths; Chromium confirmed End reaches Close file
and Escape restores focus to Open. Its Storybook fixture supplies the preview
file, so file-launch actions were not exercised against a live filesystem.

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
with an accessible group label when a heading exists. Chromium verified model
selection and Escape focus restoration in the isolated live New Chat, plus the
Storybook picker states at desktop and phone widths.
The same Range Field now owns the native Thinking effort sliders in both chat
screens and terminal font size in Settings. Chromium checked keyboard value
changes in Storybook and in the isolated live New Chat and Settings screens;
the live font-size change was restored after verification. Model-list sizing,
loading and error messages inside pickers still need shared-pattern review.

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

The Utility panel uses semantic tokens for chrome and document colors, plus
shared compact Text Field and Select controls in the file rail. Storybook's
Utility stories cover the file viewer at desktop and phone widths, its light
theme, the Changes diff, Pages, page deletion and Quick Open. Monaco owns the
diff editor. The phone page list leaves more room for the editor; page deletion
and Quick Open use the adaptive Dialog for desktop modals and phone bottom
sheets.

In isolated dev-local Chromium, a fresh terminal pane and real sessiond showed
the filtered file explorer and Quick Open phone sheet. The shared file filter
narrowed the real tree, and Storybook accepted a new sort selection. Quick Open
searched real files; Enter opened a Storybook file result and one Escape
closed a filled live search. Pages and Changes use synthetic Storybook data
because the isolated app had no chat.
