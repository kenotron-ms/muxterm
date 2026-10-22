import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import fixtureURL from '../stories/fixtures/component-library.pdf?url';
import type { MuxSDKPdfPreview } from './mux-sdk-pdf-preview.js';
import './mux-sdk-pdf-preview.js';

interface PDFArgs { state:'ready'|'empty'|'error' }
const meta = {
  title:'Composites/PDF preview', tags:['autodocs'],
  args:{state:'ready'},
  parameters:{layout:'fullscreen',fullBleed:true},
  render:() => html`<div style="display:flex;width:100%;height:100vh;min-height:480px"><mux-sdk-pdf-preview></mux-sdk-pdf-preview></div>`,
} satisfies Meta<PDFArgs>;
export default meta;
type Story = StoryObj<PDFArgs>;

async function load(canvasElement:HTMLElement, state:PDFArgs['state']):Promise<MuxSDKPdfPreview> {
  const preview = canvasElement.querySelector<MuxSDKPdfPreview>('mux-sdk-pdf-preview');
  if (!preview) throw new Error('PDF preview is missing');
  if (state === 'empty') return preview;
  preview.bytes = state === 'error' ? new Uint8Array([0,1,2,3]) : new Uint8Array(await (await fetch(fixtureURL)).arrayBuffer());
  for (let attempt=0; attempt<100; attempt++) {
    await preview.updateComplete;
    const root = preview.shadowRoot;
    if (state === 'error' ? root?.querySelector('mux-ui-feedback[kind="error"]') : root?.querySelector('canvas[width]')) return preview;
    await new Promise(resolve => window.setTimeout(resolve, 50));
  }
  throw new Error(`PDF ${state} state did not render`);
}

export const FirstPage:Story = { play:async ({canvasElement}) => { await load(canvasElement,'ready'); } };
export const SecondPage:Story = {
  play:async ({canvasElement}) => {
    const preview = await load(canvasElement,'ready');
    [...(preview.shadowRoot?.querySelectorAll<HTMLElement>('mux-ui-button') || [])].find(button => button.textContent.trim() === 'Next')?.click();
    await preview.updateComplete;
  },
};
export const Zoomed:Story = {
  play:async ({canvasElement}) => {
    const preview = await load(canvasElement,'ready');
    preview.shadowRoot?.querySelector<HTMLElement>('mux-ui-button[accessible-label="Zoom in"]')?.click();
    preview.shadowRoot?.querySelector<HTMLElement>('mux-ui-button[accessible-label="Zoom in"]')?.click();
    await preview.updateComplete;
  },
};
export const Empty:Story = { args:{state:'empty'}, play:async ({canvasElement}) => { await load(canvasElement,'empty'); } };
export const InvalidDocument:Story = { args:{state:'error'}, play:async ({canvasElement}) => { await load(canvasElement,'error'); } };
export const PhonePreview:Story = {
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:async ({canvasElement}) => { await load(canvasElement,'ready'); },
};
export const LightPreview:Story = {
  globals:{palette:'github-light'},
  play:async ({canvasElement}) => { await load(canvasElement,'ready'); },
};
