import type { Preview } from '@storybook/web-components-vite';
import { html } from 'lit';
import { MINIMAL_VIEWPORTS } from 'storybook/viewport';
import { applyChromeTokens, applyThemeTokens, isLightTheme, PALETTES, resolvePalette } from '../src/lib/theme.js';
import { APP_THEMES, BACKDROPS, applyAppAppearance, type AppThemeId, type AppThemeMode, type BackdropId } from '../src/lib/app-appearance.js';
import { injectTerminalFonts } from '../src/lib/fonts.js';
import '../src/ui/tokens.css';
import { useApiFixture, type ApiFixture } from '../src/stories/api-fixture.js';

const preview: Preview = {
  tags: ['autodocs'],
  globals: { palette: 'tokyo-night', appTheme: 'neutral', appMode: 'story', chatBackdrop: 'contours' },
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
      description: 'Terminal palette',
      toolbar: {
        title: 'Palette',
        icon: 'circlehollow',
        dynamicTitle: true,
        items: Object.keys(PALETTES).map((value) => ({ value, title: value })),
      },
    },
    appTheme: {
      description: 'App appearance',
      toolbar: { title:'App theme', icon:'paintbrush', dynamicTitle:true,
        items:APP_THEMES.map(theme => ({value:theme.id,title:theme.label})) },
    },
    chatBackdrop: {
      description: 'Chat backdrop pattern',
      toolbar: { title:'Backdrop', icon:'image', dynamicTitle:true,
        items:BACKDROPS.map(backdrop => ({value:backdrop.id,title:backdrop.label})) },
    },
    appMode: {
      description: 'App color mode',
      toolbar: { title:'App mode', icon:'contrast', dynamicTitle:true,
        items:[{value:'story',title:'Story default'},{value:'light',title:'Light'},{value:'dark',title:'Dark'}] },
    },
  },
  decorators: [
    (story, context) => {
      useApiFixture(context.parameters['apiFixture'] as ApiFixture | undefined);
      const palette = String(context.globals['palette'] || 'tokyo-night');
      injectTerminalFonts();
      applyThemeTokens(resolvePalette(palette));
      applyChromeTokens(palette);
      const chosenMode = context.globals['appMode'];
      const mode: AppThemeMode = chosenMode === 'light' || chosenMode === 'dark'
        ? chosenMode : isLightTheme(palette) ? 'light' : 'dark';
      applyAppAppearance(String(context.globals['appTheme'] || 'neutral') as AppThemeId, mode, String(context.globals['chatBackdrop'] || 'contours') as BackdropId);
      const padding = context.parameters['fullBleed'] ? '0' : '32px';
      return html`<div style="min-height:100vh;box-sizing:border-box;padding:${padding};background:var(--ui-surface-base);color:var(--ui-text);font:var(--ui-text-md)/1.5 var(--ui-font-sans)">${story()}</div>`;
    },
  ],
};

export default preview;
