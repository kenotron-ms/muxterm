import { defineMain } from '@storybook/web-components-vite/node';

export default defineMain({
  stories: ['../src/**/*.stories.ts'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  staticDirs: ['../public'],
  framework: {
    name: '@storybook/web-components-vite',
    options: { builder: { viteConfigPath: 'vite.storybook.config.ts' } },
  },
});
