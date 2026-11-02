import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON } from '../stories/api-fixture.js';
import './mux-sidebar.js';

type Destination = 'newChatActive' | 'terminalActive' | 'jobsActive' | 'connectionsActive' | 'skillsActive';

const chats = [
  { id:'sidebar-claude', title:'Refine the mobile sidebar', harness:'claude', state:'working', projectPath:'/home/demo/muxterm', createdAt:'2026-11-02T05:00:00Z', pinned:true, workspaceId:'sidebar-project' },
  { id:'sidebar-codex', title:'Normalize harness icon sizing', harness:'codex', state:'idle', projectPath:'/home/demo/muxterm', createdAt:'2026-11-02T04:00:00Z', workspaceId:'sidebar-project' },
  { id:'sidebar-copilot', title:'Check navigation spacing', harness:'copilot', state:'working', projectPath:'/home/demo/muxterm', createdAt:'2026-11-02T03:00:00Z', workspaceId:'sidebar-project' },
  { id:'sidebar-pi', title:'Keep session labels on one line', harness:'pi', state:'idle', projectPath:'/home/demo/muxterm', createdAt:'2026-11-02T02:00:00Z', workspaceId:'sidebar-project' },
  { id:'sidebar-opencode', title:'Review scroll behavior', harness:'opencode', state:'idle', projectPath:'/home/demo/muxterm', createdAt:'2026-11-02T01:00:00Z', workspaceId:'sidebar-project' },
  { id:'sidebar-deepseek', title:'Verify footer actions', harness:'deepseek', state:'idle', projectPath:'/home/demo/muxterm', createdAt:'2026-11-02T00:00:00Z', workspaceId:'sidebar-project' },
];

function view(destination: Destination = 'newChatActive', drawer = false) {
  const sidebar = html`<mux-sidebar
    style="width:100%;height:100%"
    .newChatActive=${destination === 'newChatActive'}
    .terminalActive=${destination === 'terminalActive'}
    .jobsActive=${destination === 'jobsActive'}
    .connectionsActive=${destination === 'connectionsActive'}
    .skillsActive=${destination === 'skillsActive'}
    .selectedSDKChat=${'sidebar-claude'}
    .drawer=${drawer}
  ></mux-sidebar>`;
  return html`<div style="box-sizing:border-box;display:flex;flex-direction:column;align-items:stretch;height:100dvh;width:${drawer ? '100vw' : '348px'};max-width:100vw;overflow:hidden;background:var(--ui-surface-nav);border-right:1px solid var(--ui-border);border-radius:0">
    ${drawer ? html`<header style="box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;flex:none;min-height:60px;padding:env(safe-area-inset-top,0px) 24px 0;background:var(--ui-surface-nav);border-bottom:1px solid var(--ui-border);font-size:32px;font-weight:600"><span>muxterm</span><button aria-label="Close navigation" style="border:0;background:transparent;color:inherit;font-size:20px">×</button></header>` : ''}
    <div style="flex:1;min-height:0">${sidebar}</div>
  </div>`;
}

const meta = {
  title:'Composites/Sidebar', tags:['autodocs'],
  parameters:{ fullBleed:true, layout:'fullscreen', apiFixture:({url}:{url:URL}) => {
    if (url.pathname.endsWith('/api/sdk-chats')) return fixtureJSON(chats);
    if (url.pathname.endsWith('/api/sdk-projects')) return fixtureJSON([{id:'sidebar-project',name:'Muxterm',path:'/home/demo/muxterm',pinned:true,sourceFolders:[]}]);
    if (url.pathname.endsWith('/api/remotes')) return fixtureJSON({connected:[],discovered:[]});
    if (url.pathname.endsWith('/api/update/status')) return fixtureJSON({devBuild:true,currentVersion:'dev'});
    return fixtureJSON({});
  } },
  render:() => view(),
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const NewChatSelected: Story = {};
export const TerminalSelected: Story = { render:() => view('terminalActive') };
export const ScheduledJobsSelected: Story = { render:() => view('jobsActive') };
export const ConnectionsSelected: Story = { render:() => view('connectionsActive') };
export const SkillsSelected: Story = { render:() => view('skillsActive') };
export const PhoneDrawer: Story = {
  globals:{ viewport:{value:'phone390',isRotated:false} }, render:() => view('newChatActive',true),
};
export const LightPalette: Story = { globals:{palette:'github-light'} };
