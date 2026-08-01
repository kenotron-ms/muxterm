// ---------------------------------------------------------------------------
// Sidebar width persistence — relocated from mux-sidebar.ts so app.ts's
// Split.js wiring can share it. Same validation/clamp/try-catch logic as the
// original mux-sidebar.ts connectedCallback (restore) and _onResizeStart
// (persist) blocks — just made into standalone, independently-callable pure
// functions. See docs/designs/2026-08-01-sidebar-resize-splitjs-design.md.
// ---------------------------------------------------------------------------

export const SIDEBAR_WIDTH_KEY = 'mux-sidebar-width';
export const SIDEBAR_DEFAULT_WIDTH = 220;
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 360;

/**
 * Reads the persisted sidebar width from localStorage, validating and
 * clamping it to [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]. Falls back to
 * SIDEBAR_DEFAULT_WIDTH on a missing key, an unparseable value, an
 * out-of-range value, or any localStorage access error (private browsing,
 * quota, disabled storage).
 */
export function restoreSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored !== null) {
      const parsed = parseInt(stored, 10);
      if (!Number.isNaN(parsed) && parsed >= SIDEBAR_MIN_WIDTH && parsed <= SIDEBAR_MAX_WIDTH) {
        return parsed;
      }
    }
  } catch {
    // Ignore localStorage errors — fall through to default.
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

/**
 * Persists the sidebar width to localStorage. Silently no-ops on any
 * localStorage access error (private browsing, quota, disabled storage) —
 * losing a persistence write is not a user-visible failure.
 */
export function persistSidebarWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(px));
  } catch {
    // Ignore localStorage errors.
  }
}
