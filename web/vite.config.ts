import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2021',
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
