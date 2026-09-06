// fonts.ts — injects @font-face rules for all muxterm-bundled Nerd Fonts.
//
// WOFF2 files live in web/public/fonts/ and are served by the muxterm server
// itself, ensuring Nerd Font glyphs render in any browser regardless of locally
// installed fonts. Call injectTerminalFonts() once at app startup, before any
// terminal is created. terminal-registry.ts calls WebFontsAddon.loadFonts()
// before term.open() per the official xterm.js addon-web-fonts guidance.
//
// Required font files for each family (Regular + Bold minimum):
//   JetBrainsMonoNerdFont-{Regular,Bold,Italic,BoldItalic}.woff2  (included)
//   FiraCodeNerdFont-{Regular,Bold}.woff2
//   CascadiaCodeNF-{Regular,Bold}.woff2
//   HackNerdFont-{Regular,Bold}.woff2
//   IosevkaTermNerdFont-{Regular,Bold}.woff2
//
// Font files for FiraCode, CascadiaCode, Hack, and Iosevka must be downloaded
// from https://github.com/ryanoasis/nerd-fonts/releases and placed in
// web/public/fonts/. Missing files degrade gracefully: xterm falls back to the
// configured fallback font and the preview line shows the system monospace.
//
// This module also injects the sidebar preview font (Spleen 5x8), which is NOT
// a terminal font and deliberately not in FONT_FAMILIES — see below.

import { apiPath } from './base-path.js';

/** Default CSS font-family for the terminal (the bundled JetBrains Mono NF). */
export const TERMINAL_FONT_FAMILY = 'JetBrainsMonoNerdFont';

// ---------------------------------------------------------------------------
// Sidebar preview font
// ---------------------------------------------------------------------------

/**
 * Bitmap font used to render the sidebar's live workspace previews.
 *
 * NOT user-selectable and NOT in FONT_FAMILIES: it exists solely to draw a
 * terminal grid at a 5x8 pixel cell, which no normal monospace font can do.
 * Built from the upstream BDF by tools/font/build.sh (Spleen, BSD-2-Clause).
 */
export const PREVIEW_FONT_FAMILY = 'Spleen5x8';

/**
 * Cell geometry, in CSS pixels, of PREVIEW_FONT_FAMILY.
 *
 * These are a contract, not a suggestion. The font is only crisp when rendered
 * at exactly `font-size: PREVIEW_CELL.h px` — measured in Chrome, an integer
 * font-size renders with 2 distinct colours (pure bitmap) while 8.5px renders
 * with 58, nearly every ink pixel antialiased. Callers must also draw at an
 * integer device scale; see tools/font/README.md for the full contract.
 */
export const PREVIEW_CELL = { w: 5, h: 8 } as const;

/**
 * All font families available in the settings picker.
 * - `id`      : CSS font-family name (also the value stored in config.toml)
 * - `label`   : Human-readable display name
 * - `ligatures`: Whether this font supports programming ligatures
 */
export const FONT_FAMILIES: Array<{ id: string; label: string; ligatures: boolean }> = [
  { id: 'JetBrainsMonoNerdFont', label: 'JetBrains Mono', ligatures: true },
  { id: 'FiraCodeNerdFont',       label: 'Fira Code',      ligatures: true },
  { id: 'CascadiaCodeNF',         label: 'Cascadia Code',  ligatures: true },
  { id: 'HackNerdFont',           label: 'Hack',           ligatures: false },
  { id: 'IosevkaTermNerdFont',    label: 'Iosevka',        ligatures: false },
];

/**
 * Inject @font-face rules for all bundled Nerd Font families into document.head.
 * Idempotent — skips if the style tag already exists.
 */
export function injectTerminalFonts(): void {
  const STYLE_ID = 'mux-terminal-fonts';
  if (document.getElementById(STYLE_ID)) return;

  // These @font-face rules are built at runtime, so Vite's build-time `base`
  // rewriting never sees them: the URLs must be prefixed here or every woff2
  // 404s when the app is served under a path prefix. '/fonts' at the origin
  // root, '/t/abc/fonts' behind a tunnel.
  const fontsBase = apiPath('/fonts');

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* ── JetBrains Mono Nerd Font (default, all 4 weights bundled) ── */
@font-face {
  font-family: 'JetBrainsMonoNerdFont';
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url('${fontsBase}/JetBrainsMonoNerdFont-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'JetBrainsMonoNerdFont';
  font-style: normal;
  font-weight: 700;
  font-display: block;
  src: url('${fontsBase}/JetBrainsMonoNerdFont-Bold.woff2') format('woff2');
}
@font-face {
  font-family: 'JetBrainsMonoNerdFont';
  font-style: italic;
  font-weight: 400;
  font-display: block;
  src: url('${fontsBase}/JetBrainsMonoNerdFont-Italic.woff2') format('woff2');
}
@font-face {
  font-family: 'JetBrainsMonoNerdFont';
  font-style: italic;
  font-weight: 700;
  font-display: block;
  src: url('${fontsBase}/JetBrainsMonoNerdFont-BoldItalic.woff2') format('woff2');
}
/* ── Fira Code Nerd Font ── */
@font-face {
  font-family: 'FiraCodeNerdFont';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('${fontsBase}/FiraCodeNerdFont-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'FiraCodeNerdFont';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('${fontsBase}/FiraCodeNerdFont-Bold.woff2') format('woff2');
}
/* ── Cascadia Code NF ── */
@font-face {
  font-family: 'CascadiaCodeNF';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('${fontsBase}/CascadiaCodeNF-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'CascadiaCodeNF';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('${fontsBase}/CascadiaCodeNF-Bold.woff2') format('woff2');
}
/* ── Hack Nerd Font ── */
@font-face {
  font-family: 'HackNerdFont';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('${fontsBase}/HackNerdFont-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'HackNerdFont';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('${fontsBase}/HackNerdFont-Bold.woff2') format('woff2');
}
/* ── Iosevka Term Nerd Font ── */
@font-face {
  font-family: 'IosevkaTermNerdFont';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('${fontsBase}/IosevkaTermNerdFont-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'IosevkaTermNerdFont';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('${fontsBase}/IosevkaTermNerdFont-Bold.woff2') format('woff2');
}
/* ── Spleen 5x8 — sidebar preview only, never a terminal font ──
   font-display: block because a 5x8 grid drawn in a fallback font at 8px is
   unreadable garbage; better to show nothing until the real font lands. */
@font-face {
  font-family: 'Spleen5x8';
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url('${fontsBase}/Spleen5x8.woff2') format('woff2');
}
`.trim();
  document.head.appendChild(style);
}

/**
 * @deprecated Use injectTerminalFonts() instead. This alias remains for any
 * call sites that used the old single-font name.
 */
export const injectTerminalFont = injectTerminalFonts;
