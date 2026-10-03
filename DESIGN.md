# muxterm interface design

The terminal is the main work surface. Chrome should make navigation, attention, and risky actions clear without competing with terminal content. This page describes current interface principles and points to the implementation for exact values. See [VISION.md](VISION.md) for product direction and [ARCHITECTURE.md](ARCHITECTURE.md) for state ownership.

## Surfaces

- **Workspaces and panes** organize terminal work. Dockview provides split layouts; xterm.js renders terminal content.
- **Sidebar and Dashboard** make workspaces and agent sessions visible. Agent sessions remain identifiable when they have no terminal attachment.
- **Mission Control** is the persistent Operator conversation and applet host. Its conversation is shared across workspaces.
- **Separate agent chats** have their own creation and history flow.
- **Narrow layouts** keep the same underlying surfaces and adapt their navigation, pane picker, and Mission Control sheet.

The current components are in [`web/src/app.ts`](web/src/app.ts), [`web/src/components/`](web/src/components/), and [`web/src/components/applets/`](web/src/components/applets/).

## Theme and layout

[`web/src/lib/theme.ts`](web/src/lib/theme.ts) defines and applies the live palette tokens. `--mux-*` values follow the terminal palette. `--chrome-*` values style surrounding UI and switch with the light or dark palette. Components inherit custom properties through shadow roots. Use these tokens instead of copying palette colors into individual components.

| Token | Current use |
| --- | --- |
| `--mux-bg`, `--mux-fg` | Terminal-derived surface and text colors |
| `--mux-accent`, `--mux-border` | Selection and separators |
| `--mux-ok`, `--mux-warn`, `--mux-error` | Status colors |
| `--mux-bell` | Bell indicator color; aliases `--mux-warn` |
| `--mux-dock-height`, `--mux-titlebar-height` | Shared 44px touch-scale rows |
| `--chrome-bar`, `--chrome-body`, `--chrome-border` | Surrounding surfaces |
| `--chrome-text-dim`, `--chrome-text-bright`, `--chrome-accent` | Chrome text and emphasis |

`--mux-titlebar-height` is a separate semantic name derived from the dock height. Keep sidebar and title bar geometry aligned in narrow layouts. Exact token values and light/dark chrome palettes belong in `theme.ts`.

## Interaction rules

- Keep controls that switch workspaces or panes usable by touch. The dock and title bar use 44px rows.
- A bell indicator uses `●` (`U+25CF`) and `--mux-bell`, with a 4px gap before its label. Pane and workspace indicators clear through their own focus or selection behavior.
- Show an agent's reported state rather than inferring it from terminal text.
- Keep a pane or workspace visible while a close intent is pending. Remove it after the daemon's close outcome and broadcast.
- One-shot dictation changes a draft only. Voice Mode takes over the composer while live; `type instead` returns to text without ending the call.

Feature designs under [`docs/designs/`](docs/designs/) are dated records. Consult their status and the current code before treating a proposal as shipped behavior.
