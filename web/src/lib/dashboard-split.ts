// ---------------------------------------------------------------------------
// Dashboard divider persistence.
//
// The Dashboard is ONE surface split into a conversation (left) and the fleet
// (right), with a draggable divider between them. Where the user put that
// divider is a per-eyeball display preference with no server-side meaning, so
// it lives in localStorage exactly as the sidebar's width does -- the same
// validate/clamp/try-catch shape as sidebar-width.ts, so the codebase has ONE
// idiom for "a boundary the user dragged" rather than two.
//
// A PERCENTAGE rather than the sidebar's pixels, deliberately: these two
// columns divide whatever width the surface happens to have, and that width
// itself follows the sidebar the user can also drag. A stored pixel width
// would put the divider somewhere different on every window size; a ratio
// survives the resize, which is the whole point of remembering it.
// ---------------------------------------------------------------------------

export const DASHBOARD_SPLIT_KEY = 'muxterm.dashboard.split';

/**
 * Resting position: the conversation gets a bit under half.
 *
 * The fleet grid's track is 214px minimum, so at a 1240px surface a 46% chat
 * leaves ~660px on the right -- three columns of cards. Giving the
 * conversation the larger share by default would start every user at two.
 */
export const DASHBOARD_SPLIT_DEFAULT = 46;

/**
 * The clamp. Neither column may collapse: below ~18% the conversation cannot
 * hold a line of prose, and above 78% the fleet cannot hold one 214px card
 * track on a laptop. Enforced on the way IN as well as on the way out, so a
 * hand-edited or stale stored value can never render an unusable surface.
 */
export const DASHBOARD_SPLIT_MIN = 18;
export const DASHBOARD_SPLIT_MAX = 78;

/** Clamp a percentage into the usable band. A non-number resolves to the default. */
export function clampDashboardSplit(pct: number): number {
  if (!Number.isFinite(pct)) return DASHBOARD_SPLIT_DEFAULT;
  return Math.min(DASHBOARD_SPLIT_MAX, Math.max(DASHBOARD_SPLIT_MIN, pct));
}

/**
 * The persisted divider position, as a percentage of the surface's width.
 *
 * Falls back to DASHBOARD_SPLIT_DEFAULT on a missing key, an unparseable
 * value, or any localStorage access error (private browsing, quota, disabled
 * storage). An out-of-range stored value is CLAMPED rather than discarded --
 * it still says which side the user favoured.
 */
export function restoreDashboardSplit(): number {
  try {
    const stored = localStorage.getItem(DASHBOARD_SPLIT_KEY);
    if (stored !== null) {
      const parsed = parseFloat(stored);
      if (Number.isFinite(parsed)) return clampDashboardSplit(parsed);
    }
  } catch {
    // Ignore localStorage errors -- fall through to the default.
  }
  return DASHBOARD_SPLIT_DEFAULT;
}

/**
 * Persist the divider position. Silently no-ops on any localStorage access
 * error -- losing a persistence write is not a user-visible failure.
 */
export function persistDashboardSplit(pct: number): void {
  try {
    localStorage.setItem(DASHBOARD_SPLIT_KEY, clampDashboardSplit(pct).toFixed(1));
  } catch {
    // Ignore localStorage errors.
  }
}
