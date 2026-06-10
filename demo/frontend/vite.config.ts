import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so all asset paths (./assets/index.js) resolve correctly
  // when the page is served through muxterm's /p/{port}/ proxy.
  // Absolute paths (/assets/index.js) would resolve to the muxterm origin and 404.
  base: './',
  preview: {
    port: 5173,
    strictPort: true,
  },
  server: {
    port: 5173,
    // No proxy config here — API and WebSocket calls use absolute localhost URLs
    // (BACKEND_HTTP = 'http://localhost:9002', BACKEND_WS = 'ws://localhost:9002').
    // DO NOT add a proxy here: that would bypass the muxterm shim and defeat the test.
  },
});
