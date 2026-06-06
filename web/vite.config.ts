import { defineConfig } from 'vite';
import { resolve } from 'path';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
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
        // No precaching — every request always goes to the network.
        // The SW exists only to satisfy the PWA installability requirement
        // (launch icon, standalone display mode) without ever serving stale content.
        globPatterns: [],
        // Wipe caches left by any previous SW version on next activate.
        cleanupOutdatedCaches: true,
      },
      // Keep the SW out of `vite dev` and the vitest build so local dev and
      // tests are unaffected; it is only emitted by `vite build`.
      devOptions: { enabled: false },
    }),
  ],
  build: {
    outDir: 'dist',
    target: 'es2021',
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:9090', ws: true, changeOrigin: true },
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
    ],
  },
});
