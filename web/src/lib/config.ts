import { apiPath } from './base-path.js';

// ── Persistence helpers ──────────────────────────────────────────────────────

/**
 * Converts a TypeScript camelCase ResolvedConfig back to the Go snake_case
 * format used by PATCH /api/config. Only includes user-settable fields
 * (theme, font, terminal, sidebar) — keys, workspace, and driver are not
 * changed through the settings UI in Phase 5.
 */
export function configToGoJSON(cfg: ResolvedConfig): Record<string, unknown> {
  return {
    theme: {
      palette: cfg.theme.palette,
    },
    font: {
      family: cfg.font.family,
      size: cfg.font.size,
    },
    terminal: {
      cursor_style: cfg.terminal.cursorStyle,
      cursor_blink: cfg.terminal.cursorBlink,
      scrollback: cfg.terminal.scrollback,
      bell: cfg.terminal.bell,
    },
    sidebar: {
      preview: cfg.sidebar.preview,
    },
  };
}


let _patchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced PATCH /api/config — sends a partial config object to the server,
 * which merges it, writes to disk, and broadcasts to all connected clients.
 *
 * Calls are debounced at 500 ms so rapid slider / radio changes produce a
 * single HTTP request. The server always applies the last-sent partial, so
 * intermediate values are applied optimistically in-memory by the caller.
 *
 * The partial object uses the Go/TOML snake_case key names, not camelCase
 * TypeScript names, because the server decodes a raw config.Config JSON.
 *
 * @param partial - Partial config in Go snake_case JSON format
 *   e.g. { theme: { palette: "dracula" }, font: { size: 15 } }
 */
export function patchConfig(partial: Record<string, unknown>): void {
  if (_patchTimer !== null) {
    clearTimeout(_patchTimer);
  }
  _patchTimer = setTimeout(() => {
    _patchTimer = null;
    fetch(apiPath('/api/config'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    }).catch((err: unknown) => {
      // Log but do not roll back — the optimistic in-memory update already
      // applied. A retry will happen on the next user interaction.
      console.warn('patchConfig: PATCH /api/config failed:', err);
    });
  }, 500);
}

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
  sidebar: {
    /** Live workspace preview density. 'off' also stops all preview traffic. */
    preview: 'full' | 'compact' | 'off';
  };
  keys: {
    nextSession: string;
    split: string;
    maximizeRegion: string;
    popOut: string;
    openLauncher: string;
    focusDriver: string;
    /** Show/hide the home view. Printable chord — see keybindings.ts. */
    toggleHome: string;
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
    // Default to the server-bundled JetBrains Mono Nerd Font, served from
    // /fonts/ by the muxterm server itself. This ensures Nerd Font glyphs
    // (folder icons, git symbols, etc.) render correctly in any browser,
    // regardless of what fonts are installed on the client machine.
    family: 'JetBrainsMonoNerdFont',
    size: 13,
  },
  terminal: {
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 10000,
    bell: 'visual',
  },
  sidebar: {
    preview: 'full',
  },
  keys: {
    nextSession: 'ctrl+shift+]',
    split: 'ctrl+shift+\\',
    maximizeRegion: 'ctrl+shift+m',
    popOut: 'ctrl+shift+o',
    openLauncher: 'ctrl+shift+p',
    focusDriver: 'ctrl+shift+a',
    toggleHome: 'ctrl+`',
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
 * Sidebar preview density is a closed three-value vocabulary, unlike the other
 * string fields here which are passed through and cast. It is validated because
 * the preview pipeline switches on it directly — an unrecognised value must
 * degrade to the default, never to a mode that does not exist.
 */
function previewMode(v: unknown, def: ResolvedConfig['sidebar']['preview']): ResolvedConfig['sidebar']['preview'] {
  return v === 'full' || v === 'compact' || v === 'off' ? v : def;
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
  const sb = obj(r['sidebar']);
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
    sidebar: {
      preview: previewMode(sb['preview'], d.sidebar.preview),
    },
    keys: {
      nextSession: str(k['next_session'], d.keys.nextSession),
      split: str(k['split'], d.keys.split),
      maximizeRegion: str(k['maximize_region'], d.keys.maximizeRegion),
      popOut: str(k['pop_out'], d.keys.popOut),
      openLauncher: str(k['open_launcher'], d.keys.openLauncher),
      focusDriver: str(k['focus_driver'], d.keys.focusDriver),
      toggleHome: str(k['toggle_home'], d.keys.toggleHome),
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
