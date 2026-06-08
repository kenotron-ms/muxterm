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

export type Palette = typeof THEME;

export const GRUVBOX: Palette = {
  background: '#282828',
  foreground: '#ebdbb2',
  cursor: '#ebdbb2',
  cursorAccent: '#282828',
  selectionBackground: '#504945',
  black: '#282828',
  red: '#cc241d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  magenta: '#b16286',
  cyan: '#689d6a',
  white: '#a89984',
  brightBlack: '#928374',
  brightRed: '#fb4934',
  brightGreen: '#b8bb26',
  brightYellow: '#fabd2f',
  brightBlue: '#83a598',
  brightMagenta: '#d3869b',
  brightCyan: '#8ec07c',
  brightWhite: '#ebdbb2',
};

export const PALETTES: Record<string, Palette> = {
  'tokyo-night': THEME,
  gruvbox: GRUVBOX,
};

export function resolvePalette(name: string): Palette {
  return PALETTES[name] ?? THEME;
}

/** Maps a Palette to canonical --mux-* CSS custom property names. */
export function paletteToCSSVars(p: Palette): Record<string, string> {
  return {
    '--mux-bg': p.background,
    '--mux-fg': p.foreground,
    '--mux-accent': p.blue,
    '--mux-border': p.brightBlack,
    '--mux-selection': p.selectionBackground,
    '--mux-warn': p.yellow,
    '--mux-error': p.red,
    '--mux-ok': p.green,
    // New tokens for attention management + dock redesign
    '--mux-bell':               'var(--mux-warn)',  // bell indicator dot color
    '--mux-dock-height':        '44px',             // dock bar row height / touch target
    '--mux-dock-item-padding':  '0 16px',           // horizontal padding on each dock slot
    '--mux-dock-font-size':     '0.85rem',          // workspace label font size
    '--mux-dock-active-weight': '600',              // active workspace label font weight
  };
}

/** Applies --mux-* CSS variables from a Palette to the given root element. */
export function applyThemeTokens(
  p: Palette,
  root: HTMLElement = document.documentElement,
): void {
  const vars = paletteToCSSVars(p);
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
}
