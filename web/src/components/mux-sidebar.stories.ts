import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { store } from '../state.js';
import { SessiondType } from '../types.js';
import { fixtureJSON } from '../stories/api-fixture.js';
import './mux-sidebar.js';

type Destination = 'newChatActive' | 'terminalActive' | 'jobsActive' | 'connectionsActive' | 'skillsActive';

function seedWorkspaces() {
  store.applySessiond({ type:SessiondType.WorkspaceList, workspaces:[
    { workspaceId:'story-atlas', name:'Atlas', paneCount:2 },
    { workspaceId:'story-build', name:'Build logs', paneCount:1 },
    { workspaceId:'story-research', name:'Research notes', paneCount:3 },
  ] });
  store.applySessiond({ type:SessiondType.Composition, workspaceId:'story-atlas', panes:[
    { paneId:1, title:'Editor', cols:80, rows:24 },
    { paneId:2, title:'Server', cols:80, rows:24 },
  ], layout:'' });
}

function view(destination: Destination = 'newChatActive', drawer = false) {
  seedWorkspaces();
  return html`<div style="display:flex;align-items:stretch;height:844px;width:${drawer ? '335px' : '348px'};max-width:100vw;background:var(--ui-surface-nav);border-right:1px solid var(--ui-border)">
    <mux-sidebar
      style="width:100%"
      .newChatActive=${destination === 'newChatActive'}
      .terminalActive=${destination === 'terminalActive'}
      .jobsActive=${destination === 'jobsActive'}
      .connectionsActive=${destination === 'connectionsActive'}
      .skillsActive=${destination === 'skillsActive'}
      .drawer=${drawer}
      .showLauncher=${!drawer}
    ></mux-sidebar>
  </div>`;
}

const meta = {
  title:'Composites/Sidebar', tags:['autodocs'],
  parameters:{ fullBleed:true, layout:'fullscreen', apiFixture:({url}:{url:URL}) => {
    if (url.pathname.endsWith('/api/sdk-chats') || url.pathname.endsWith('/api/sdk-projects')) return fixtureJSON([]);
    if (url.pathname.endsWith('/api/update/status')) return fixtureJSON({devBuild:true});
    return fixtureJSON({});
  } },
  render:() => view(),
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const NewChatSelected: Story = {};
export const TerminalSelected: Story = { render:() => view('terminalActive') };
export const ScheduledJobsSelected: Story = { render:() => view('jobsActive') };
export const SkillsSelected: Story = { render:() => view('skillsActive') };
export const WorkspaceChooser: Story = { render:() => view('terminalActive'), play:async ({canvasElement}) => {
  const sidebar = canvasElement.querySelector('mux-sidebar');
  await sidebar?.updateComplete;
  sidebar?.shadowRoot?.querySelector<HTMLButtonElement>('.terminal-picker')?.click();
} };
export const PhoneDrawer: Story = {
  globals:{ viewport:{value:'phone390',isRotated:false} }, render:() => view('newChatActive',true),
};
