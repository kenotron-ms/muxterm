/**
 * mux-log — centralized lifecycle logger.
 *
 * All output prefixed with [mux:TAG] so you can filter in DevTools:
 *   console filter: "[mux:"
 *
 * Controlled by localStorage flag so you can toggle without rebuilding:
 *   localStorage.setItem('muxDebug', '1')   // enable
 *   localStorage.removeItem('muxDebug')      // disable
 *
 * Always on in dev; in prod gated by the flag.
 */

function _enabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (import.meta.env.DEV) return true;
  try {
    return localStorage.getItem('muxDebug') === '1';
  } catch {
    return false;
  }
}

let _t0 = Date.now();

export function muxLog(tag: string, msg: string, data?: Record<string, unknown>): void {
  if (!_enabled()) return;
  const elapsed = ((Date.now() - _t0) / 1000).toFixed(3);
  if (data) {
    console.log(`[mux:${tag}] +${elapsed}s ${msg}`, data);
  } else {
    console.log(`[mux:${tag}] +${elapsed}s ${msg}`);
  }
}

/** Reset the elapsed timer (call on page load or reconnect). */
export function muxLogReset(): void {
  _t0 = Date.now();
}
