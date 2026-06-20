import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { writeFileSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Writes a single sentinel file (dist/build.stamp) after ALL Vite outputs —
 * including vite-plugin-pwa's service worker — are flushed to disk.
 *
 * air watches web/dist for files with extension "stamp" only, so a Vite
 * rebuild triggers exactly one Go rebuild instead of cascading per-file
 * rebuilds (main bundle → sw.js → workbox-*.js).
 */
const rebuildSignal = (): Plugin => ({
  name: 'rebuild-signal',
  apply: 'build',
  enforce: 'post', // runs after vite-plugin-pwa's own closeBundle hook
  closeBundle() {
    writeFileSync('dist/build.stamp', String(Date.now()));
  },
});

const gitSha = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

export default defineConfig({
  plugins: [
    rebuildSignal(),
    VitePWA({
      // Auto-update: a new SW activates and reloads clients on next visit.
      registerType: 'autoUpdate',
      // Inject the registration snippet straight into index.html so we don't
      // need a source-level import (keeps the app code and the test build clean).
      injectRegister: 'auto',
      includeAssets: [
        'favicon.svg',
        'favicon-32.png',
        'apple-touch-icon.png',
        'icons/icon.svg',
        'icons/icon-maskable.svg',
      ],
      manifest: {
        name: 'muxterm',
        short_name: 'muxterm',
        description: 'A terminal multiplexer in your browser.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#1a1b26',
        theme_color: '#1a1b26',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // No precaching — every request goes to the network.
        // The SW exists for PWA installability (launch icon, standalone mode)
        // and will be used for browser-tab notification features.
        globPatterns: [],
        // navigateFallback: null — do NOT let the SW intercept navigation
        // requests and serve a cached index.html. Without this, the SW caches
        // the first index.html it sees and serves it forever, causing users to
        // see stale app versions after a deploy.
        navigateFallback: null,
        // Wipe caches left by any previous SW version on activate.
        cleanupOutdatedCaches: true,
      },
      // Keep the SW out of `vite dev` and the vitest build so local dev and
      // tests are unaffected; it is only emitted by `vite build`.
      devOptions: { enabled: false },
    }),
  ],
  define: {
    // Baked in at build time; also available in vitest since it reads this config.
    __GIT_SHA__: JSON.stringify(gitSha),
  },
  build: {
    outDir: 'dist',
    target: 'es2021',
  },
  server: {
    port: 5173,
    proxy: {
      '/ws/browser': { target: 'ws://127.0.0.1:8312', ws: true, changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8312', ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    passWithNoTests: true,
    alias: [
      // 'ghostty-web' → setup.ts (original)
      { find: 'ghostty-web', replacement: resolve(__dirname, 'src/__tests__/setup.ts') },
      // '@xterm/xterm' (exact package, NOT subpath like .../css/xterm.css) →
      // setup.ts mock. Using RegExp ^...$ so that the raw CSS import
      // '@xterm/xterm/css/xterm.css?raw' is NOT matched and still resolves
      // from the real installed package.
      {
        find: /^@xterm\/xterm$/,
        replacement: resolve(__dirname, 'src/__tests__/setup.ts'),
      },
      {
        find: /^@xterm\/addon-fit$/,
        replacement: resolve(__dirname, 'src/__tests__/setup.ts'),
      },
      // CSS ?inline imports from node_modules fail in the worktree environment
      // because node_modules is a symlink to the parent workspace; Vite's
      // filesystem security rejects the resolved real path outside the project
      // root.  Return an empty string — the CSS is not needed in unit tests.
      {
        find: /^@xterm\/xterm\/css\/xterm\.css/,
        replacement: resolve(__dirname, 'src/__tests__/css-inline-mock.ts'),
      },
      {
        find: /^dockview-core\/dist\/styles\/dockview\.css/,
        replacement: resolve(__dirname, 'src/__tests__/css-inline-mock.ts'),
      },
    ],
  },
});
