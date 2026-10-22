import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON } from '../stories/api-fixture.js';
import type { MuxWorkspaceCreateDialog } from './workspace-create-dialog.js';
import './mux-sidebar.js';
import './workspace-create-dialog.js';

type Destination = 'newChatActive' | 'terminalActive' | 'jobsActive' | 'connectionsActive' | 'skillsActive';

function view(destination: Destination = 'newChatActive', drawer = false, createFlow = false) {
  return html`<div style="display:flex;align-items:stretch;height:844px;width:${drawer ? '335px' : '348px'};max-width:100vw;background:var(--ui-surface-nav);border-right:1px solid var(--ui-border)">
    <mux-sidebar
      style="width:100%"
      .newChatActive=${destination === 'newChatActive'}
      .terminalActive=${destination === 'terminalActive'}
      .jobsActive=${destination === 'jobsActive'}
      .connectionsActive=${destination === 'connectionsActive'}
      .skillsActive=${destination === 'skillsActive'}
      .drawer=${drawer}
      @workspace-create=${(event:Event) => {
        const dialog = (event.currentTarget as HTMLElement).parentElement?.querySelector<MuxWorkspaceCreateDialog>('mux-workspace-create-dialog');
        if (dialog) dialog.open = true;
      }}
    ></mux-sidebar>
    ${createFlow ? html`<mux-workspace-create-dialog @workspace-create-cancel=${(event:Event) => { (event.currentTarget as MuxWorkspaceCreateDialog).open = false; }}></mux-workspace-create-dialog>` : ''}
  </div>`;
}

const meta = {
  title:'Composites/Sidebar', tags:['autodocs'],
  parameters:{ fullBleed:true, layout:'fullscreen', apiFixture:({url}:{url:URL}) => {
    if (url.pathname.endsWith('/api/sdk-chats') || url.pathname.endsWith('/api/sdk-projects')) return fixtureJSON([]);
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
export const WorkspaceCreateAction: Story = { render:() => view('terminalActive'),
  play:async ({canvasElement}) => { canvasElement.querySelector('mux-sidebar')?.shadowRoot?.querySelector<HTMLElement>('.workspace-create-action')?.focus(); },
};
const openWorkspaceDialog = async ({canvasElement}:{canvasElement:HTMLElement}) => {
  canvasElement.querySelector('mux-sidebar')?.shadowRoot?.querySelector<HTMLElement>('.workspace-create-action')?.click();
};
export const WorkspaceCreateDialog: Story = { render:() => view('terminalActive',false,true), play:openWorkspaceDialog };
export const PhoneWorkspaceCreateDialog: Story = {
  globals:{ viewport:{value:'phone390',isRotated:false} },
  render:() => view('terminalActive',true,true), play:openWorkspaceDialog,
};
export const LightPalette: Story = { globals:{palette:'github-light'} };
