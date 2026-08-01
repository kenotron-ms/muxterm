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
