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

/** Default CSS font-family for the terminal (the bundled JetBrains Mono NF). */
export const TERMINAL_FONT_FAMILY = 'JetBrainsMonoNerdFont';

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

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* ── JetBrains Mono Nerd Font (default, all 4 weights bundled) ── */
@font-face {
  font-family: 'JetBrainsMonoNerdFont';
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url('/fonts/JetBrainsMonoNerdFont-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'JetBrainsMonoNerdFont';
  font-style: normal;
  font-weight: 700;
  font-display: block;
  src: url('/fonts/JetBrainsMonoNerdFont-Bold.woff2') format('woff2');
}
@font-face {
  font-family: 'JetBrainsMonoNerdFont';
  font-style: italic;
  font-weight: 400;
  font-display: block;
  src: url('/fonts/JetBrainsMonoNerdFont-Italic.woff2') format('woff2');
}
@font-face {
  font-family: 'JetBrainsMonoNerdFont';
  font-style: italic;
  font-weight: 700;
  font-display: block;
  src: url('/fonts/JetBrainsMonoNerdFont-BoldItalic.woff2') format('woff2');
}
/* ── Fira Code Nerd Font ── */
@font-face {
  font-family: 'FiraCodeNerdFont';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/FiraCodeNerdFont-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'FiraCodeNerdFont';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/FiraCodeNerdFont-Bold.woff2') format('woff2');
}
/* ── Cascadia Code NF ── */
@font-face {
  font-family: 'CascadiaCodeNF';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/CascadiaCodeNF-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'CascadiaCodeNF';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/CascadiaCodeNF-Bold.woff2') format('woff2');
}
/* ── Hack Nerd Font ── */
@font-face {
  font-family: 'HackNerdFont';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/HackNerdFont-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'HackNerdFont';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/HackNerdFont-Bold.woff2') format('woff2');
}
/* ── Iosevka Term Nerd Font ── */
@font-face {
  font-family: 'IosevkaTermNerdFont';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/IosevkaTermNerdFont-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'IosevkaTermNerdFont';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/IosevkaTermNerdFont-Bold.woff2') format('woff2');
}
`.trim();
  document.head.appendChild(style);
}

/**
 * @deprecated Use injectTerminalFonts() instead. This alias remains for any
 * call sites that used the old single-font name.
 */
export const injectTerminalFont = injectTerminalFonts;
