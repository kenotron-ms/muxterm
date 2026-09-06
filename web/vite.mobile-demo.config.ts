import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'path';

/**
 * Copies ONLY the bitmap preview font out of web/public.
 *
 * Vite's `publicDir` would copy the whole directory — every bundled Nerd Font,
 * ~16 MB — into a mockup that uses exactly one of them. The mockup is meant to
 * be served over a tunnel and opened on a phone; that is a rude download for no
 * benefit, and a phone is exactly where it hurts.
 */
const previewFontOnly = (): Plugin => ({
  name: 'mobile-demo-preview-font',
  apply: 'build',
  closeBundle() {
    const dist = resolve(__dirname, 'dist-mobile-demo');
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
 * Build config for the mobile-navigation mockup.
 *
 * DELIBERATELY SEPARATE from vite.config.ts, for the same reason
 * vite.demo.config.ts is: adding a second HTML input there would put the mockup
 * inside dist/, which web/embed.go compiles into the muxterm binary — the
 * mockup would then ship to every user. Its own root and its own outDir keeps
 * the production build byte-for-byte unchanged.
 *
 *   npx vite build --config vite.mobile-demo.config.ts   # from web/
 *   → web/dist-mobile-demo/   (index.html + assets/ + fonts/Spleen5x8.woff2)
 *
 * Serve the output directory with any static file server. `base: './'` makes
 * every emitted URL relative, so it works from a server root, a subdirectory,
 * or behind a muxterm tunnel path prefix without rebuilding.
 *
 * NO single-file variant, unlike vite.demo.config.ts. That plugin exists so the
 * home preview can be double-clicked off disk; this mockup's whole point is to
 * be opened on a phone over a tunnel, which is a served URL by definition. It
 * also hardcodes `index.html` and asserts the output holds no `./` sibling
 * references — an assertion this page would fail, since it links its own icon.
 */
export default defineConfig({
  root: resolve(__dirname, 'demo-mobile'),
  publicDir: false,
  base: './',
  plugins: [previewFontOnly()],
  define: {
    // app.ts bakes this in via the main config; nothing in the mockup path
    // reads it, but define it anyway so a future shared import cannot break
    // the build.
    __GIT_SHA__: JSON.stringify('mobile-demo'),
  },
  build: {
    outDir: resolve(__dirname, 'dist-mobile-demo'),
    emptyOutDir: true,
    target: 'es2021',
  },
});
