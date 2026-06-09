import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // No proxy config here — API and WebSocket calls use absolute localhost URLs
    // (BACKEND_HTTP = 'http://localhost:9002', BACKEND_WS = 'ws://localhost:9002').
    // DO NOT add a proxy here: that would bypass the muxterm shim and defeat the test.
  },
});
