// sw.ts — service worker registration.
//
// This replaces the snippet vite-plugin-pwa used to inject into index.html
// (`injectRegister: 'auto'`, now null). It registers the same file at the same
// scope on the same event, with one added condition: it does nothing unless
// the app is mounted at the origin root.
//
// Why the condition: the SW's scope is capped by where it is served from, so
// an app served at /t/<id>/ can only register a SW scoped to /t/<id>/. Tunnel
// ids are ephemeral and random, so every visit through a new tunnel would
// leave behind a separate registration precaching the icon set into a scope
// that no longer resolves to anything, with nothing to ever clean it up. A
// tunnel is a review URL, not an install target — no offline support there.
//
// The root-scoped SW does NOT interfere with a prefixed mount: it precaches
// only origin-root URLs (/favicon.svg, /manifest.webmanifest, /icons/*) and
// `navigateFallback: null` keeps it out of navigations, so requests under
// /t/<id>/ miss every precache route and go to the network.

import { BASE_PATH } from './base-path.js';

export function registerServiceWorker(): void {
  if (BASE_PATH !== '/') return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Registration failing is never fatal: the app is fully functional
      // without a service worker (it precaches nothing and serves nothing).
    });
  });
}
