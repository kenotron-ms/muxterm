import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import '../ui/dialog.js';
import './mux-connect-dialog.js';
import type { MuxConnectDialog } from './mux-connect-dialog.js';

const discovered = [
  { id:'ssh:build-box', name:'Build box', target:'ken@build-box', probe:'present' },
  { id:'ssh:gpu-01', name:'GPU 01', target:'ken@gpu-01', probe:'absent' },
];

const fixture = (rows = discovered, outcome: 'connecting'|'error' = 'connecting'): ApiFixture => ({url,method}) => {
  if (method === 'GET' && url.pathname.endsWith('/api/remotes')) return fixtureJSON({discovered:rows});
  if (method === 'POST' && /\/api\/remotes\/[^/]+\/(connect|provision)$/.test(url.pathname)) {
    return outcome === 'error'
      ? fixtureJSON({error:'No route to host'},503)
      : fixtureJSON({probe:'present',user:'ken',path:'/usr/local/bin/muxterm',state:'connecting'});
  }
  if (method === 'POST' && url.pathname.endsWith('/api/remotes')) return fixtureJSON({id:'ssh:manual-host'});
  return fixtureJSON({error:`No story fixture for ${method} ${url.pathname}`},404);
};

const meta = {
  title:'Composites/Connect machine',
  tags:['autodocs'],
  parameters:{layout:'fullscreen',apiFixture:fixture()},
  render:() => html`<mux-ui-dialog open size="compact" label="Connect machine"><mux-connect-dialog></mux-connect-dialog></mux-ui-dialog>`,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function discoveredDialog(canvasElement: HTMLElement): Promise<MuxConnectDialog> {
  const dialog = canvasElement.querySelector<MuxConnectDialog>('mux-connect-dialog');
  if (!dialog) throw new Error('Connect dialog is missing');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (dialog.shadowRoot?.querySelector('[role="radio"]')) return dialog;
    await new Promise(resolve => window.setTimeout(resolve, 50));
  }
  throw new Error('Discovered machine rows did not load');
}

export const Discovered: Story = {};
export const InstallAvailable: Story = {
  play:async ({canvasElement}) => {
    const dialog = await discoveredDialog(canvasElement);
    dialog.shadowRoot?.querySelectorAll<HTMLElement>('[role="radio"]')[1]?.click();
  },
};
export const Connecting: Story = {
  play:async ({canvasElement}) => {
    const dialog = await discoveredDialog(canvasElement);
    dialog.shadowRoot?.querySelector<HTMLElement>('[role="radio"]')?.click();
    await dialog.updateComplete;
    dialog.shadowRoot?.querySelector<HTMLElement>('mux-ui-button[variant="primary"]')?.click();
  },
};
export const Failed: Story = {
  parameters:{apiFixture:fixture(discovered,'error')},
  play:Connecting.play,
};
export const Manual: Story = { parameters:{apiFixture:fixture([])} };
export const Phone: Story = {
  globals:{viewport:{value:'phone390',isRotated:false}},
};
export const Light: Story = { globals:{palette:'github-light'} };
