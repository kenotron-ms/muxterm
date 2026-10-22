import { defineConfig } from 'vite';

// Storybook is a catalog. Keep the app's PWA and build.stamp hooks out of it:
// those hooks are for the dev-local server and would trigger an air rebuild.
export default defineConfig({
  base: './',
  // Only explicitly public Storybook variables may enter a Pages bundle.
  envPrefix: 'STORYBOOK_PUBLIC_',
  define: { __GIT_SHA__: JSON.stringify('storybook') },
  build: { target: 'es2021' },
});
