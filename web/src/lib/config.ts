// ResolvedConfig mirrors Go internal/config.Config with camelCase keys.
export interface ResolvedConfig {
  theme: { palette: string };
  font: { family: string; size: number };
  terminal: {
    cursorStyle: 'block' | 'bar' | 'underline';
    cursorBlink: boolean;
    scrollback: number;
    bell: 'visual' | 'audible' | 'off';
  };
  keys: {
    nextSession: string;
    split: string;
    maximizeRegion: string;
    popOut: string;
    openLauncher: string;
    focusDriver: string;
  };
  workspace: {
    defaultPresentation: 'docked' | 'single';
    rails: string[];
  };
  driver: {
    autostart: boolean;
    sharedWindowPolicy: string;
    launch: string;
  };
}

// DEFAULT_RESOLVED_CONFIG mirrors Go internal/config.Defaults() exactly.
export const DEFAULT_RESOLVED_CONFIG: ResolvedConfig = {
  theme: { palette: 'tokyo-night' },
  font: {
    // Match Zellij's web client, which sets xterm's fontFamily to "Monospace".
    // This resolves to the OS-configured default monospace font (via fontconfig
    // on Linux), which is properly hinted and renders crisply — unlike a stack
    // of named fonts that aren't installed and fall through to a poor fallback.
    family: 'Monospace',
    size: 13,
  },
  terminal: {
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 10000,
    bell: 'visual',
  },
  keys: {
    nextSession: 'ctrl+shift+]',
    split: 'ctrl+shift+\\',
    maximizeRegion: 'ctrl+shift+m',
    popOut: 'ctrl+shift+o',
    openLauncher: 'ctrl+shift+p',
    focusDriver: 'ctrl+shift+a',
  },
  workspace: {
    defaultPresentation: 'docked',
    rails: ['sessions'],
  },
  driver: {
    autostart: false,
    sharedWindowPolicy: 'follow',
    launch: 'muxterm-agent',
  },
};

// --- Internal helpers ---

/** Safe object cast — returns the value if it's a non-null object, else {}. */
function obj(v: unknown): Record<string, unknown> {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

/** Safe string with default. */
function str(v: unknown, def: string): string {
  return typeof v === 'string' ? v : def;
}

/** Safe finite number with default. */
function num(v: unknown, def: number): number {
  return typeof v === 'number' && isFinite(v) ? v : def;
}

/** Safe boolean with default. */
function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

/**
 * parseResolvedConfig reads a raw server response (snake_case) and maps it
 * to a ResolvedConfig (camelCase). Falls back to DEFAULT_RESOLVED_CONFIG for
 * any missing or invalid field.
 */
export function parseResolvedConfig(raw: unknown): ResolvedConfig {
  const d = DEFAULT_RESOLVED_CONFIG;

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return d;
  }

  const r = raw as Record<string, unknown>;

  const t = obj(r['theme']);
  const f = obj(r['font']);
  const term = obj(r['terminal']);
  const k = obj(r['keys']);
  const ws = obj(r['workspace']);
  const drv = obj(r['driver']);

  const rails: string[] = Array.isArray(ws['rails'])
    ? (ws['rails'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : [...d.workspace.rails];

  return {
    theme: {
      palette: str(t['palette'], d.theme.palette),
    },
    font: {
      family: str(f['family'], d.font.family),
      size: num(f['size'], d.font.size),
    },
    terminal: {
      cursorStyle: str(term['cursor_style'], d.terminal.cursorStyle) as ResolvedConfig['terminal']['cursorStyle'],
      cursorBlink: bool(term['cursor_blink'], d.terminal.cursorBlink),
      scrollback: num(term['scrollback'], d.terminal.scrollback),
      bell: str(term['bell'], d.terminal.bell) as ResolvedConfig['terminal']['bell'],
    },
    keys: {
      nextSession: str(k['next_session'], d.keys.nextSession),
      split: str(k['split'], d.keys.split),
      maximizeRegion: str(k['maximize_region'], d.keys.maximizeRegion),
      popOut: str(k['pop_out'], d.keys.popOut),
      openLauncher: str(k['open_launcher'], d.keys.openLauncher),
      focusDriver: str(k['focus_driver'], d.keys.focusDriver),
    },
    workspace: {
      defaultPresentation: str(
        ws['default_presentation'],
        d.workspace.defaultPresentation,
      ) as ResolvedConfig['workspace']['defaultPresentation'],
      rails,
    },
    driver: {
      autostart: bool(drv['autostart'], d.driver.autostart),
      sharedWindowPolicy: str(drv['shared_window_policy'], d.driver.sharedWindowPolicy),
      launch: str(drv['launch'], d.driver.launch),
    },
  };
}
