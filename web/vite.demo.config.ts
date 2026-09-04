import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'path';

/**
 * Copies ONLY the bitmap preview font out of web/public.
 *
 * Vite's `publicDir` would copy the whole directory — every bundled Nerd Font,
 * ~16 MB — into a preview that uses exactly one of them. The demo is meant to
 * be served over a tunnel and clicked; that is a rude download for no benefit.
 */
const previewFontOnly = (): Plugin => ({
  name: 'demo-preview-font',
  apply: 'build',
  closeBundle() {
    const dist = resolve(__dirname, 'dist-demo');
    mkdirSync(resolve(dist, 'fonts'), { recursive: true });
    copyFileSync(
      resolve(__dirname, 'public/fonts/Spleen5x8.woff2'),
      resolve(dist, 'fonts/Spleen5x8.woff2'),
    );
    // Without this the browser probes /favicon.ico on its own and logs a 404
    // in the console of the page someone was asked to go and look at.
    copyFileSync(
      resolve(__dirname, 'public/favicon.svg'),
      resolve(dist, 'favicon.svg'),
    );
  },
});

/**
 * Build config for the standalone home-view preview.
 *
 * DELIBERATELY SEPARATE from vite.config.ts. Adding a second HTML input there
 * would put the demo inside dist/, which web/embed.go compiles into the
 * muxterm binary — the preview would then ship to every user. Its own config
 * and its own outDir keeps the production build byte-for-byte unchanged.
 *
 *   npx vite build --config vite.demo.config.ts      # from web/
 *   → web/dist-demo/   (index.html + assets/ + fonts/Spleen5x8.woff2)
 *
 * Serve the output directory with any static file server. `base: './'` makes
 * every emitted URL relative, so it works from a server root, a subdirectory,
 * or behind a tunnel path prefix without rebuilding.
 */
export default defineConfig({
  root: resolve(__dirname, 'demo'),
  publicDir: false,
  base: './',
  plugins: [previewFontOnly()],
  define: {
    // app.ts bakes this in via the main config; nothing in the demo path reads
    // it, but define it anyway so a future shared import cannot break the build.
    __GIT_SHA__: JSON.stringify('demo'),
  },
  build: {
    outDir: resolve(__dirname, 'dist-demo'),
    emptyOutDir: true,
    target: 'es2021',
  },
});
