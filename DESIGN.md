# muxterm — Design Document

**Status:** Living document. Updated as visual design decisions are made.
**Scope:** Visual design language, design tokens, component visual states, interaction patterns.
**Audience:** Frontend contributors. For technical architecture, see [ARCHITECTURE.md](ARCHITECTURE.md). For feature-level implementation designs, see [docs/superpowers/specs/](docs/superpowers/specs/).

---

## Context and Scope

muxterm is a browser-based terminal multiplexer. The UI wraps terminal content — the content
*is* the product, not the chrome. The visual design has one job: stay out of the way of the
terminal while making workspace and pane navigation fast and legible on any device.

Design decisions flow from three constraints:

1. **Terminal-first** — chrome elements must not compete with terminal content for visual weight.
2. **Palette-derived** — chrome uses colors from the active terminal palette, so the UI always
   looks coherent regardless of which color scheme the user runs.
3. **Touch-capable** — interactive targets must be reliably tappable on mobile without
   sacrificing desktop density.

---

## Goals

- Document all design tokens so contributors know what variables exist and what they mean.
- Establish consistent visual patterns for chrome elements (title bar, tabs, dock, indicators).
- Define touch target standards.
- Provide a token reference for new feature visual design — feature specs reference tokens from
  here rather than hardcoding values.

## Non-Goals

- Terminal rendering details (controlled by xterm.js and the user's palette).
- Animation timings (TBD — will be added here when decisions are made).
- Full accessibility audit (future work).

---

## Design Tokens

All tokens are CSS custom properties. They are derived from the active terminal palette by
`paletteToVars()` in `web/src/lib/theme.ts` and applied to `:root` at startup. When the
palette changes, all tokens update automatically and chrome re-renders with the new values.

### Color tokens

| Token | Semantic meaning | Default (Tokyo Night) |
|---|---|---|
| `--mux-bg` | Primary background for all chrome surfaces | `#1a1b26` |
| `--mux-fg` | Primary text on chrome surfaces | `#a9b1d6` |
| `--mux-accent` | Active / selected state highlight | `#7aa2f7` (blue) |
| `--mux-border` | Dividers, panel borders | `#414868` (brightBlack) |
| `--mux-ok` | Success, connected | palette green |
| `--mux-warn` | Warning | palette yellow / amber |
| `--mux-error` | Error, disconnected | palette red |
| `--mux-selection` | Text selection background | palette selectionBackground |

### Proposed tokens (attention management + dock redesign)

These tokens do not exist yet. They will be introduced as part of the attention management
and dock bar feature. See `docs/superpowers/specs/2026-06-07-attention-management-design.md`.

| Token | Semantic meaning | Proposed value |
|---|---|---|
| `--mux-bell` | Bell indicator dot color | `var(--mux-warn)` |
| `--mux-dock-height` | Height of the dock bar row (sets touch target) | `44px` |
| `--mux-dock-item-padding` | Horizontal padding on each dock workspace item | `0 16px` |
| `--mux-dock-font-size` | Workspace label font size in the dock | `0.85rem` |
| `--mux-dock-active-weight` | Font weight for the active workspace label | `600` |

### Spacing and layout

| Value | Usage |
|---|---|
| `44px` minimum | Any interactive element that must be reliably tappable on mobile |
| `16px` | Standard horizontal item padding / gap |
| `8px` | Internal chrome padding |
| `4px` | Tight spacing (e.g. indicator dot + label gap) |

### Typography

Chrome elements use the system UI font stack. Terminal content uses the configured monospace
font from `web/src/lib/config.ts`.

| Surface | Font | Size | Weight |
|---|---|---|---|
| Dock workspace labels | system-ui | `--mux-dock-font-size` (0.85rem) | 400 inactive / 600 active |
| Pane tab labels | system-ui | 0.875rem | 400 |
| Status / utility text | system-ui | 0.8rem | 400 |
| Terminal content | configured monospace | configured size | 400 |

---

## Component Visual States

### Pane tab

| State | Treatment |
|---|---|
| Inactive | Muted `--mux-fg` |
| Active | `--mux-accent` underline or stronger fg |
| Bell active | `●` prefix in `--mux-bell` (amber) |

### Dock bar workspace slot

| State | Treatment |
|---|---|
| Inactive | Muted `--mux-fg`, generous horizontal padding for touch |
| Active | `font-weight: var(--mux-dock-active-weight)` or `--mux-accent` tint |
| Bell active | `●` prefix in `--mux-bell` (amber) |

The dock bar has no boxes around individual items. Padding alone creates the tap target.
Minimum touch target height is `var(--mux-dock-height)` (`44px`).

### Connection indicator (far right of dock bar)

| State | Treatment |
|---|---|
| Connected | `--mux-ok` |
| Disconnected / reconnecting | `--mux-error` |

---

## Interaction Patterns

### Touch targets

All workspace-switching and pane-switching controls must be at least 44×44px. This is
enforced via `--mux-dock-height` and `min-height` on dock items. Desktop users experience
this as generous, comfortable click targets — no downside.

### Bell / attention indicator

The `●` character (U+25CF BLACK CIRCLE) is prepended to a label when that label's
corresponding pane or workspace has an unacknowledged bell. Color: `var(--mux-bell)`.
A `4px` gap separates the dot from the label text.

Indicators clear independently:
- **Pane tab dot** clears when the user focuses that pane.
- **Dock workspace dot** clears when the user switches to that workspace.

---

## Alternatives Considered

**SVG icon instead of `●` for the bell indicator.** Rejected — a Unicode character is
zero-dependency, renders predictably in both monospace and system-ui fonts, and carries no
specific notification metaphor (the dot reads as "attention needed" without implying sound).

**Storing tokens in a JS/TS constant file instead of CSS custom properties.** Rejected —
CSS custom properties cascade naturally from the palette, can be inspected in devtools, and
update instantly when the palette changes without any JS plumbing.

**Separate `--mux-bell` color instead of aliasing `--mux-warn`.** Deferred — today both
would resolve to the same amber. If a future palette has an unusable yellow, `--mux-bell`
can be overridden without touching `--mux-warn`. The indirection costs nothing now.

---

## Open Questions

- Should the active dock workspace slot use `font-weight: 600` or an `--mux-accent` color
  tint? (Both options noted above — to be decided during implementation.)
- Should the bell dot appear instantly or fade in over ~150ms? (Animation tokens TBD.)

---

## References

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — technical architecture, event taxonomy, FSMs, known bugs
- [`web/src/lib/theme.ts`](web/src/lib/theme.ts) — palette-to-token mapping implementation
- [`web/src/lib/config.ts`](web/src/lib/config.ts) — terminal font and bell config
- [`docs/superpowers/specs/`](docs/superpowers/specs/) — per-feature implementation design documents
