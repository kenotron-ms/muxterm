// Instance identity for browser titles across named muxterm hosts.

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
