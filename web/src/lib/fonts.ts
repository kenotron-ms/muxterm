// fonts.ts — injects @font-face rules for the muxterm-bundled Nerd Font.
//
// The WOFF2 files live in web/public/fonts/ and are served by the muxterm
// server itself, so the font works regardless of what the client has installed.
// Call injectTerminalFont() once at app startup, before any xterm.js Terminal
// is created. The terminal-registry already waits on document.fonts.ready, so
// xterm will correctly delay rendering until the font is downloaded.

/** CSS font-family name used in the @font-face declaration and in xterm config. */
export const TERMINAL_FONT_FAMILY = 'JetBrainsMonoNerdFont';

/**
 * Inject @font-face rules for the bundled JetBrains Mono Nerd Font into
 * document.head. Idempotent — skips if the style tag already exists.
 */
export function injectTerminalFont(): void {
  const STYLE_ID = 'mux-terminal-font';
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
@font-face {
  font-family: '${TERMINAL_FONT_FAMILY}';
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url('/fonts/JetBrainsMonoNerdFont-Regular.woff2') format('woff2');
}
@font-face {
  font-family: '${TERMINAL_FONT_FAMILY}';
  font-style: normal;
  font-weight: 700;
  font-display: block;
  src: url('/fonts/JetBrainsMonoNerdFont-Bold.woff2') format('woff2');
}
@font-face {
  font-family: '${TERMINAL_FONT_FAMILY}';
  font-style: italic;
  font-weight: 400;
  font-display: block;
  src: url('/fonts/JetBrainsMonoNerdFont-Italic.woff2') format('woff2');
}
@font-face {
  font-family: '${TERMINAL_FONT_FAMILY}';
  font-style: italic;
  font-weight: 700;
  font-display: block;
  src: url('/fonts/JetBrainsMonoNerdFont-BoldItalic.woff2') format('woff2');
}
`.trim();
  document.head.appendChild(style);
}
