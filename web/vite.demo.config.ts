import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
 * Emits a second artifact: ONE self-contained .html that opens off disk.
 *
 * The served build is the primary one -- it caches properly and works behind a
 * tunnel. But "open the preview" is a gesture people perform by double-clicking
 * a file, and a browser refuses ES modules on a file:// URL, so the served
 * build cannot answer that gesture. An INLINE module script is not fetched, so
 * it is not subject to that rule; the bundle has no dynamic imports and no
 * import.meta, so inlining it is exact rather than approximate. The font and
 * the icon become data: URIs for the same reason.
 *
 * Runs after previewFontOnly, reading its sources from web/public directly so
 * it does not depend on that plugin's output.
 */
const singleFileVariant = (): Plugin => ({
  name: 'demo-single-file',
  apply: 'build',
  enforce: 'post',
  closeBundle() {
    const dist = resolve(__dirname, 'dist-demo');
    const htmlPath = resolve(dist, 'index.html');
    let html = readFileSync(htmlPath, 'utf8');

    // Inline the one emitted chunk.
    const tag = /<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/;
    const m = tag.exec(html);
    if (!m) throw new Error('demo-single-file: no module script tag found in index.html');
    const jsPath = resolve(dist, m[1].replace(/^\.\//, ''));
    const js = readFileSync(jsPath, 'utf8');
    // REPLACER FUNCTIONS, never replacement strings, for every substitution
    // below. String.replace() interprets $&, $`, $', $1... inside a replacement
    // STRING, and a minified bundle is full of `$` and backticks. Passing the
    // bundle as a string silently spliced the document's own <head> into the
    // middle of the JavaScript and grew the file by 7 KB -- a corrupt artifact
    // that still built, still weighed about the right amount, and still opened.
    // A function's return value is used literally.
    //
    // A literal </script anywhere in the bundle would also close the tag early.
    // The current bundle contains none; escaped anyway, because "currently
    // none" is a property of today's source, not a guarantee.
    const safeJs = js.replace(/<\/script/gi, '<\\/script');
    html = html.replace(tag, () => `<script type="module">${safeJs}</script>`);

    // Font and icon as data: URIs -- a file:// page cannot fetch siblings either.
    const font = readFileSync(resolve(__dirname, 'public/fonts/Spleen5x8.woff2')).toString('base64');
    html = html.replace(
      "url('./fonts/Spleen5x8.woff2') format('woff2')",
      () => `url('data:font/woff2;base64,${font}') format('woff2')`,
    );
    const icon = readFileSync(resolve(__dirname, 'public/favicon.svg')).toString('base64');
    html = html.replace('href="./favicon.svg"', () => `href="data:image/svg+xml;base64,${icon}"`);

    // Prove the artifact rather than trust it: the bundle must appear in the
    // output byte-for-byte, and nothing may still point at a sibling file.
    if (!html.includes(safeJs)) {
      throw new Error('demo-single-file: inlined bundle does not match the emitted chunk');
    }
    if (/(?:src|href)="\.\//.test(html)) {
      throw new Error('demo-single-file: output still references a sibling file');
    }
    writeFileSync(resolve(dist, 'home-standalone.html'), html);
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
  plugins: [previewFontOnly(), singleFileVariant()],
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
