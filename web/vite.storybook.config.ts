import { defineConfig } from 'vite';

// Storybook is a catalog. Keep the app's PWA and build.stamp hooks out of it:
// those hooks are for the dev-local server and would trigger an air rebuild.
export default defineConfig({
  base: './',
  define: { __GIT_SHA__: JSON.stringify('storybook') },
  build: { target: 'es2021' },
});
