import type { Preview } from '@storybook/web-components-vite';
import { html } from 'lit';
import { MINIMAL_VIEWPORTS } from 'storybook/viewport';
import { applyChromeTokens, applyThemeTokens, PALETTES, resolvePalette } from '../src/lib/theme.js';
import { injectTerminalFonts } from '../src/lib/fonts.js';
import '../src/ui/tokens.css';
import { useApiFixture, type ApiFixture } from '../src/stories/api-fixture.js';

const preview: Preview = {
  tags: ['autodocs'],
  globals: { palette: 'tokyo-night' },
  parameters: {
    viewport: {
      options: {
        ...MINIMAL_VIEWPORTS,
        phone390: { name:'Phone 390', styles:{ width:'390px', height:'844px' }, type:'mobile' },
      },
    },
  },
  globalTypes: {
    palette: {
      description: 'Muxterm terminal palette and app chrome',
      toolbar: {
        title: 'Palette',
        icon: 'circlehollow',
        dynamicTitle: true,
        items: Object.keys(PALETTES).map((value) => ({ value, title: value })),
      },
    },
  },
  decorators: [
    (story, context) => {
      useApiFixture(context.parameters['apiFixture'] as ApiFixture | undefined);
      const palette = String(context.globals['palette'] || 'tokyo-night');
      injectTerminalFonts();
      applyThemeTokens(resolvePalette(palette));
      applyChromeTokens(palette);
      const padding = context.parameters['fullBleed'] ? '0' : '32px';
      return html`<div style="min-height:100vh;box-sizing:border-box;padding:${padding};background:var(--ui-surface-base);color:var(--ui-text);font:var(--ui-text-md)/1.5 var(--ui-font-sans)">${story()}</div>`;
    },
  ],
};

export default preview;
