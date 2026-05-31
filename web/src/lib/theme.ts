// Tokyo Night theme — matches the rest of the UI.
// Exported here so both terminal-registry (Terminal config) and
// pane.ts (CSS background) share a single source of truth.

// VS Code tab + chrome design tokens (Tokyo Night palette).
export const CHROME = {
  bar: '#16161e',         // title bar / tab strip / status bar background
  body: '#1a1b26',        // surface body — active tab merges into this
  border: '#292e42',      // hairline separators
  textDim: '#565f89',     // inactive tab / muted labels
  textBright: '#c0caf5',  // active tab / focused text
  accent: '#7aa2f7',      // normal active-tab top line + focus accent
  driverAccent: '#bb9af7', // driver region accent (magenta)
  hover: '#1f2335',       // flat icon-button hover background
  danger: '#f7768e',      // close-× hover
};

export const THEME = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#283457',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
};
