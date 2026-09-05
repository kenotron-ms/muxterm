// base-path.ts — the single source of truth for the URL prefix this app is
// mounted under.
//
// muxterm is normally served at the origin root ("/"), but it can also be
// served under a path prefix: its own tunnel route (/t/<id>/), or any fronting
// reverse proxy that strips a prefix before forwarding. Every URL the client
// builds at RUNTIME — the WebSocket, /api/*, /fonts/* — must be relative to
// that prefix, or it lands at the origin root and 404s. Build-time asset URLs
// (the module bundle, the manifest, the icons) are handled separately by
// Vite's `base: './'`, which makes them document-relative.
//
// The prefix is derived from document.baseURI, NOT parsed out of
// location.pathname looking for a "/t/" segment. Two reasons:
//   1. With `base: './'` the browser has already resolved the mount point for
//      us — it is the directory of the document that loaded the bundle.
//   2. Nothing here should know about muxterm's own tunnel route. A prefix
//      applied by nginx, Caddy, or a cloud ingress works identically.
//
// Caveat, and it is a real one: this only works when the document URL ends in
// a slash. "https://host/t/abc" (no trailing slash) makes the browser resolve
// "./assets/index.js" to "/t/assets/index.js" — the bundle never loads, so no
// client-side code, including this file, ever runs. That case must be fixed by
// a redirect to the directory form before the HTML is served; muxterm's own
// tunnel handler does exactly that (see handleTunnelProxy in
// internal/server/server.go). A third-party reverse proxy must do the same.

/**
 * Path prefix this app is mounted under. "/" at the origin root, "/t/abc/"
 * behind a tunnel. Always starts and ends with "/".
 */
export const BASE_PATH: string = deriveBasePath();

function deriveBasePath(): string {
  try {
    // new URL('.', baseURI) resolves to the *directory* of the document.
    const dir = new URL('.', document.baseURI).pathname;
    if (dir === '') return '/';
    return dir.endsWith('/') ? dir : dir + '/';
  } catch {
    // Opaque or non-hierarchical document base (about:blank, data:). Behave
    // exactly as if mounted at the root.
    return '/';
  }
}

/**
 * Absolute-from-origin URL for a server path.
 *
 *   apiPath('/api/config') → '/api/config'        at the origin root
 *                          → '/t/abc/api/config'  behind a tunnel
 */
export function apiPath(p: string): string {
  return BASE_PATH + (p.startsWith('/') ? p.slice(1) : p);
}

/**
 * Full ws:// or wss:// URL for a server path.
 *
 *   wsUrl('/ws') → 'ws://host/ws'  |  'wss://host/t/abc/ws'
 */
export function wsUrl(p: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${apiPath(p)}`;
}
