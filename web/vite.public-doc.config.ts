import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * The public-document renderer, built ON ITS OWN, into its own directory.
 *
 * WHY A SEPARATE BUILD. This bundle is loaded by /p/{id} -- an UNAUTHENTICATED
 * route -- so the server has to be able to name the file it serves. Adding a
 * second entry to the main build would give it a content-hashed name and, far
 * worse, would let Rollup hoist anything the two entries share (lit, marked,
 * the markdown renderer) into a shared chunk with a hashed name of its own.
 * The public page would then try to fetch that chunk from /assets/..., which
 * is BEHIND the auth middleware, and a reader with no muxterm account would
 * get a login redirect instead of a document.
 *
 * So: one entry, no other entries to share with, `inlineDynamicImports` to
 * forbid splitting outright, and a fixed output name that
 * internal/server/publish_api.go's publicAssetPath can point at.
 *
 * WHY ITS OWN outDir. `vite build --watch` (what `make dev-local` runs) empties
 * dist/ when it starts. Anything this build had written there would be gone.
 * dist-public/ is never touched by the main build, and vice versa, so the two
 * can be built in either order, any number of times. web/embed.go embeds both.
 */
export default defineConfig({
  build: {
    outDir: 'dist-public',
    emptyOutDir: true,
    target: 'es2021',
    // No hashed asset names and no code splitting: the server serves exactly
    // one file from this directory, by name.
    rollupOptions: {
      input: resolve(__dirname, 'src/public-doc.ts'),
      output: {
        entryFileNames: 'public-doc.js',
        inlineDynamicImports: true,
      },
    },
  },
});
