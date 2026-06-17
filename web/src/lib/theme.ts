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

export const CATPPUCCIN: Palette = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#313244',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#cba6f7',
  cyan: '#89dceb',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#cba6f7',
  brightCyan: '#89dceb',
  brightWhite: '#a6adc8',
};

export const DRACULA: Palette = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: '#44475a',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
};

export const NORD: Palette = {
  background: '#2e3440',
  foreground: '#d8dee9',
  cursor: '#d8dee9',
  cursorAccent: '#2e3440',
  selectionBackground: '#434c5e',
  black: '#3b4252',
  red: '#bf616a',
  green: '#a3be8c',
  yellow: '#ebcb8b',
  blue: '#81a1c1',
  magenta: '#b48ead',
  cyan: '#88c0d0',
  white: '#e5e9f0',
  brightBlack: '#4c566a',
  brightRed: '#bf616a',
  brightGreen: '#a3be8c',
  brightYellow: '#ebcb8b',
  brightBlue: '#81a1c1',
  brightMagenta: '#b48ead',
  brightCyan: '#8fbcbb',
  brightWhite: '#eceff4',
};

// ── Light themes ─────────────────────────────────────────────────────────────

export const SOLARIZED_LIGHT: Palette = {
  background: '#fdf6e3',
  foreground: '#657b83',
  cursor: '#586e75',
  cursorAccent: '#fdf6e3',
  selectionBackground: '#eee8d5',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#002b36',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
};

export const ONE_LIGHT: Palette = {
  background: '#fafafa',
  foreground: '#383a42',
  cursor: '#526fff',
  cursorAccent: '#fafafa',
  selectionBackground: '#d0d0d0',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#a0a1a7',
  brightBlack: '#4f525e',
  brightRed: '#e45649',
  brightGreen: '#50a14f',
  brightYellow: '#c18401',
  brightBlue: '#4078f2',
  brightMagenta: '#a626a4',
  brightCyan: '#0184bc',
  brightWhite: '#a0a1a7',
};

export const GITHUB_LIGHT: Palette = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: '#d3e8fd',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

export const PALETTES: Record<string, Palette> = {
  // Dark themes
  'tokyo-night': THEME,
  catppuccin: CATPPUCCIN,
  gruvbox: GRUVBOX,
  dracula: DRACULA,
  nord: NORD,
  // Light themes
  'solarized-light': SOLARIZED_LIGHT,
  'one-light': ONE_LIGHT,
  'github-light': GITHUB_LIGHT,
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
