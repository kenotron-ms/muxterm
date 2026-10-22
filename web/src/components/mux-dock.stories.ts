import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { terminalRegistry } from '../lib/terminal-registry.js';
import { resolvePalette } from '../lib/theme.js';
import { homeSessions } from '../lib/home-sessions.js';
import { FIXTURE_SESSIONS } from '../lib/session-state.js';
import { store } from '../state.js';
import type { SessiondPaneInfo } from '../types.js';
import type { MuxDock } from './mux-dock.js';
import './mux-dock.js';

const workspace = 'storybook-dock';
const pane = (paneId: number, title: string): SessiondPaneInfo => ({ paneId, title, cols:80, rows:24 });

function terminal(paneId: number, title: string, light = false): void {
  terminalRegistry.setWorkspace(workspace);
  const fresh = terminalRegistry.getTerminal(paneId) === null;
  terminalRegistry.ensure(paneId, { onInput:() => {}, onResize:() => {} });
  if (light) terminalRegistry.getTerminal(paneId)!.options.theme = resolvePalette('github-light');
  if (fresh) terminalRegistry.write(paneId,
    `\x1b[2m${title.toUpperCase()}\x1b[0m\r\n\r\n` +
    '\x1b[32m$\x1b[0m muxterm status\r\n' +
    'Workspace ready. Terminal rendering uses the real xterm.js host.\r\n\r\n' +
    '\x1b[32m$\x1b[0m ');
}

function view(firstId: number, options: { narrow?: boolean; light?: boolean; utilityOpen?: boolean } = {}) {
  terminal(firstId, 'Shell', options.light);
  return html`<div style="box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100vh;min-height:480px;background:var(--ui-surface-base)">
    <mux-dock .workspaceKey=${workspace} .panes=${[pane(firstId,'Shell')]}
      .activePaneId=${firstId} .narrow=${!!options.narrow}
      .terminalUtilityOpen=${!!options.utilityOpen}
      @pane-create=${(event: Event) => {
        const dock = event.currentTarget as MuxDock;
        const nextId = Math.max(firstId, ...dock.panes.map(item => item.paneId)) + 1;
        terminal(nextId, nextId === firstId + 1 ? 'Build logs' : 'Shell');
        dock.panes = [...dock.panes, pane(nextId, nextId === firstId + 1 ? 'Build logs' : 'Shell')];
        dock.activePaneId = nextId;
      }}
      @pane-select=${(event: CustomEvent<{paneId:number}>) => { (event.currentTarget as MuxDock).activePaneId = event.detail.paneId; }}
      @pane-close=${(event: CustomEvent<{paneId:number}>) => {
        const status = (event.currentTarget as HTMLElement).nextElementSibling;
        if (status) status.textContent = `Close requested for pane ${event.detail.paneId}; waiting for sessiond.`;
      }}
      @terminal-utility-toggle=${(event: Event) => { const dock = event.currentTarget as MuxDock; dock.terminalUtilityOpen = !dock.terminalUtilityOpen; }}
    ></mux-dock>
    <div role="status" style="box-sizing:border-box;min-height:var(--ui-control-md);padding:var(--ui-space-4) var(--ui-space-5);border-top:1px solid var(--ui-border);color:var(--ui-text-muted)">Dockview owns panel layout; sessiond owns pane lifecycle.</div>
  </div>`;
}

async function ready(canvasElement: HTMLElement): Promise<MuxDock> {
  const dock = canvasElement.querySelector<MuxDock>('mux-dock');
  if (!dock) throw new Error('Dock fixture is missing');
  await dock.updateComplete;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (dock.querySelector('.xterm-screen')) return dock;
    await new Promise(resolve => window.setTimeout(resolve, 50));
  }
  throw new Error('Terminal did not attach to Dockview');
}

async function create(canvasElement: HTMLElement, action: 'New pane'|'Split pane'): Promise<MuxDock> {
  const dock = await ready(canvasElement);
  const button = dock.querySelector<HTMLButtonElement>(`.mux-header-btn[title="${action}"]`);
  if (!button) throw new Error(`${action} is missing`);
  button.click();
  await dock.updateComplete;
  return dock;
}

const meta = {
  title:'Composites/Terminal dock', tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true},
  render:() => view(501),
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SinglePane: Story = { play:async ({canvasElement}) => { await ready(canvasElement); } };
export const AttentionAndSession: Story = {
  render:() => {
    homeSessions.set([{ ...FIXTURE_SESSIONS[0], paneId: 581, workspaceId: workspace }], 'fixture');
    store.ringPane(581);
    return view(581);
  },
  play:async ({canvasElement}) => { await ready(canvasElement); },
};
export const Tabs: Story = {
  render:() => view(511),
  play:async ({canvasElement}) => { await create(canvasElement,'New pane'); },
};
export const ManyTabs: Story = {
  render:() => view(516),
  play:async ({canvasElement}) => {
    for (let index = 0; index < 7; index++) await create(canvasElement,'New pane');
  },
};
export const SplitPane: Story = {
  render:() => view(521),
  play:async ({canvasElement}) => { await create(canvasElement,'Split pane'); },
};
export const CloseIntent: Story = {
  render:() => view(531),
  play:async ({canvasElement}) => {
    const dock = await create(canvasElement,'New pane');
    dock.querySelector<HTMLButtonElement>('.dv-active-tab .dv-default-tab-action')?.click();
  },
};
export const WorkspaceActions: Story = {
  render:() => view(541,{utilityOpen:true}),
  play:async ({canvasElement}) => { await ready(canvasElement); },
};
export const PhoneTabs: Story = {
  globals:{viewport:{value:'phone390',isRotated:false}},
  render:() => view(551,{narrow:true}),
  play:async ({canvasElement}) => { await create(canvasElement,'New pane'); },
};
export const PhoneAfterSplit: Story = {
  globals:{viewport:{value:'phone390',isRotated:false}},
  render:() => view(561),
  play:async ({canvasElement}) => {
    const dock = await create(canvasElement,'Split pane');
    dock.narrow = true;
    await dock.updateComplete;
  },
};
export const ViewportRoundTrip: Story = {
  render:() => view(566),
  play:async ({canvasElement}) => {
    const dock = await create(canvasElement,'Split pane');
    dock.narrow = true;
    await dock.updateComplete;
    dock.activePaneId = 566;
    await dock.updateComplete;
    dock.narrow = false;
    await dock.updateComplete;
    if (dock.querySelectorAll('.dv-groupview').length !== 2 || dock.activePaneId !== 566)
      throw new Error('Wide split or phone pane selection was not restored');
  },
};
export const LightPalette: Story = {
  globals:{palette:'github-light'},
  render:() => view(571,{light:true}),
  play:async ({canvasElement}) => { await ready(canvasElement); },
};
