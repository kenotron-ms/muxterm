// ---------------------------------------------------------------------------
// Instance identity — per-browser (localStorage), NOT server-config-backed.
//
// The same muxterm binary/config.toml can be deployed to many different
// hosts (e.g. vela0.ampbox.io, res0.ampbox.io) that otherwise render
// pixel-identical UIs, making them impossible to tell apart when installed
// as separate PWAs or when several windows are open side by side. This
// module gives each *origin* (hostname) a distinct document title and an
// optional user-chosen title-bar accent color.
//
// Deliberately client-side/localStorage rather than routed through
// /api/config: each hostname already has its own isolated localStorage, so
// this persists correctly per-machine with zero server changes. The
// tradeoff is it does not sync across different browsers/devices hitting
// the same instance — see docs if that's ever needed, at which point this
// should migrate to the ResolvedConfig/config.toml pattern (see theme.ts).
// ---------------------------------------------------------------------------

const TITLEBAR_COLOR_KEY = 'mux-titlebar-color';

/** A single preset swatch: a friendly name + its hex value. */
export interface TitlebarCrayon {
  name: string;
  hex: string;
}

// ---------------------------------------------------------------------------
// Curated preset palettes ("crayons" — same idea as macOS's classic Crayons
// color picker tab: a small set of named, hand-picked colors instead of a
// fully free-form picker). Split by theme brightness because the header's
// text color does NOT change with the custom background (it stays
// --chrome-text-bright), so each set is tuned for contrast against that:
//   - Dark themes: --chrome-text-bright is near-white (#c0caf5) → crayons
//     need to stay on the darker/more saturated side.
//   - Light themes: --chrome-text-bright is near-black (#1c1c1e) → crayons
//     need to stay on the lighter/pastel side.
// Every entry here is verified (see settings-surface.ts test coverage note
// in the PR) to meet at least a 4.5:1 contrast ratio against its intended
// text color.
// ---------------------------------------------------------------------------

export const DARK_TITLEBAR_CRAYONS: TitlebarCrayon[] = [
  { name: 'Cayenne',   hex: '#923737' },
  { name: 'Mocha',     hex: '#754e30' },
  { name: 'Marigold',  hex: '#744e0b' },
  { name: 'Clover',    hex: '#296144' },
  { name: 'Teal',      hex: '#18605c' },
  { name: 'Ocean',     hex: '#2b5889' },
  { name: 'Indigo',    hex: '#4a4a96' },
  { name: 'Grape',     hex: '#6b4290' },
  { name: 'Berry',     hex: '#8b3964' },
  { name: 'Slate',     hex: '#4d5666' },
];

export const LIGHT_TITLEBAR_CRAYONS: TitlebarCrayon[] = [
  { name: 'Salmon',     hex: '#f4b3ab' },
  { name: 'Cantaloupe', hex: '#f6cd8b' },
  { name: 'Banana',     hex: '#f2e392' },
  { name: 'Honeydew',   hex: '#c9e4a8' },
  { name: 'Spindrift',  hex: '#a9e2cd' },
  { name: 'Sky',        hex: '#aed9f2' },
  { name: 'Orchid',     hex: '#ddbbea' },
  { name: 'Carnation',  hex: '#f4b8d3' },
  { name: 'Sand',       hex: '#e5d7ba' },
  { name: 'Fog',        hex: '#dbe1e8' },
];

/** Hostnames that are "this machine" rather than a distinct named instance. */
const GENERIC_HOSTS = new Set(['localhost', '127.0.0.1', '']);

/**
 * A short label identifying which machine this muxterm instance is running
 * on — the hostname (e.g. "res0.ampbox.io"), or "muxterm" for localhost/dev
 * where there's nothing meaningful to disambiguate.
 */
export function instanceLabel(loc: Pick<Location, 'hostname'> = window.location): string {
  const host = loc.hostname;
  return GENERIC_HOSTS.has(host) ? 'muxterm' : host;
}

/**
 * Sets document.title to reflect the URL this instance was loaded from, so
 * installed PWA windows / browser tabs / Alt-Tab previews are distinguishable
 * across different machines (e.g. "muxterm — res0.ampbox.io").
 */
export function applyDocumentTitle(loc: Pick<Location, 'hostname'> = window.location): void {
  const label = instanceLabel(loc);
  document.title = label === 'muxterm' ? 'muxterm' : `muxterm — ${label}`;
}

/**
 * Reads the persisted title-bar accent color from localStorage. Returns
 * null if unset or on any localStorage access error (private browsing,
 * quota, disabled storage) — callers should treat null as "use the theme's
 * default chrome color".
 */
export function restoreTitlebarColor(): string | null {
  try {
    return localStorage.getItem(TITLEBAR_COLOR_KEY);
  } catch {
    return null;
  }
}

/**
 * Persists the title-bar accent color, or clears it when passed null.
 * Silently no-ops on any localStorage access error.
 */
export function persistTitlebarColor(color: string | null): void {
  try {
    if (color) {
      localStorage.setItem(TITLEBAR_COLOR_KEY, color);
    } else {
      localStorage.removeItem(TITLEBAR_COLOR_KEY);
    }
  } catch {
    // Ignore localStorage errors.
  }
}

/**
 * Applies (or clears) the --mux-titlebar-bg CSS custom property, which
 * mux-title-bar uses in preference to the theme's --chrome-bar when set.
 */
export function applyTitlebarColor(
  color: string | null,
  root: HTMLElement = document.documentElement,
): void {
  if (color) {
    root.style.setProperty('--mux-titlebar-bg', color);
  } else {
    root.style.removeProperty('--mux-titlebar-bg');
  }
}
