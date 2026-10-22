import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { chatListFixture, resetChatListFixture } from '../stories/chat-list-fixture.js';
import type { MuxChatList, MuxChatWorkspace } from './mux-chat-list.js';
import type { MuxUIDialog } from '../ui/dialog.js';
import type { MuxUIButton } from '../ui/button.js';
import type { MuxUIListRow } from '../ui/list-row.js';
import type { MuxUIMenuItem } from '../ui/menu-item.js';
import './mux-chat-list.js';

function view(selectedSession = 'chat-editor', phone = false, empty = false, linkedLane = false, failProjectUpdate = false) {
  resetChatListFixture(empty, linkedLane, failProjectUpdate);
  return html`<div style="box-sizing:border-box;width:${phone ? '335px' : '348px'};max-width:100vw;min-height:844px;padding:var(--ui-space-4);background:var(--ui-surface-nav);color:var(--ui-text)">
    <mux-chat-list .selectedSession=${selectedSession}></mux-chat-list>
  </div>`;
}

const meta = {
  title:'Composites/Chat list', tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true,apiFixture:chatListFixture},
  render:() => view(),
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ProjectsAndPinned: Story = {};
const openProjectActions = async ({canvasElement}: {canvasElement: HTMLElement}) => {
  const list = canvasElement.querySelector<MuxChatList>('mux-chat-list');
  await list?.updateComplete;
  const project = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'atlas');
  project?.shadowRoot?.querySelector<MuxUIButton>('mux-ui-button[accessible-label="Project options for Atlas"]')?.click();
};
export const ProjectActions: Story = { play:openProjectActions };
export const PhoneProjectActions: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true),play:ProjectActions.play };
const showProjectActionError = async (context: {canvasElement: HTMLElement}) => {
  await openProjectActions(context);
  const list = context.canvasElement.querySelector<MuxChatList>('mux-chat-list');
  const project = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'atlas');
  await project?.updateComplete;
  [...(project?.shadowRoot?.querySelectorAll<MuxUIMenuItem>('mux-ui-menu-item') ?? [])].find(item => item.textContent?.includes('Unpin project'))?.click();
};
export const ProjectActionError: Story = { render:() => view('chat-editor',false,false,false,true), play:showProjectActionError };
export const PhoneProjectActionError: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true,false,false,true), play:showProjectActionError };
const showPinnedActionError = async ({canvasElement}: {canvasElement: HTMLElement}) => {
  const list = canvasElement.querySelector<MuxChatList>('mux-chat-list');
  await list?.updateComplete;
  list?.shadowRoot?.querySelector<MuxUIButton>('mux-ui-button[accessible-label="Unpin project Atlas"]')?.click();
};
export const PinnedActionError: Story = { render:() => view('chat-editor',false,false,false,true), play:showPinnedActionError };
export const PhonePinnedActionError: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true,false,false,true), play:showPinnedActionError };
const openMoveChat = async ({canvasElement}: {canvasElement: HTMLElement}) => {
  const list = canvasElement.querySelector<MuxChatList>('mux-chat-list');
  await list?.updateComplete;
  const project = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'atlas');
  const row = [...(project?.shadowRoot?.querySelectorAll<HTMLElement>('.chat-row') ?? [])].find(node => node.querySelector<MuxUIListRow>('mux-ui-list-row')?.label === 'Build and deployment logs');
  row?.querySelector<MuxUIButton>('.action.more')?.click();
  await project?.updateComplete;
  [...(row?.querySelectorAll<MuxUIMenuItem>('mux-ui-menu-item') ?? [])].find(item => item.textContent?.includes('Move to project'))?.click();
};
export const MoveChatActions: Story = { play:openMoveChat };
export const PhoneMoveChatActions: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true),play:openMoveChat };
export const Empty: Story = { render:() => view('',false,true) };
export const AnotherSelectedChat: Story = { render:() => view('chat-notes') };
export const ArchivedExpanded: Story = { play:async ({canvasElement}) => {
  const list = canvasElement.querySelector<MuxChatList>('mux-chat-list');
  await list?.updateComplete;
  const archived = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'archived');
  archived?.shadowRoot?.querySelector<MuxUIListRow>('.group')?.click();
} };
export const ArchivedChatMenu: Story = { play:async ({canvasElement}) => {
  const list = canvasElement.querySelector<MuxChatList>('mux-chat-list');
  await list?.updateComplete;
  const archived = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'archived');
  archived?.shadowRoot?.querySelector<MuxUIListRow>('.group')?.click();
  await archived?.updateComplete;
  archived?.shadowRoot?.querySelector<MuxUIButton>('.chat-row .action.more')?.click();
} };
export const PhoneList: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true) };
export const PhoneArchivedExpanded: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true), play:ArchivedExpanded.play };
const openProjectEditor = async ({canvasElement}: {canvasElement: HTMLElement}) => {
  const list = canvasElement.querySelector<MuxChatList>('mux-chat-list');
  await list?.updateComplete;
  const project = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'atlas');
  project?.shadowRoot?.querySelector<MuxUIButton>('mux-ui-button[accessible-label="Edit Atlas"]')?.click();
};
export const EditProject: Story = { play:openProjectEditor };
export const PhoneEditProject: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true), play:openProjectEditor };
const showEditProjectError = async (context: {canvasElement: HTMLElement}) => {
  await openProjectEditor(context);
  const list = context.canvasElement.querySelector<MuxChatList>('mux-chat-list');
  const project = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'atlas');
  await project?.updateComplete;
  project?.shadowRoot?.querySelector<MuxUIButton>('.editor-actions mux-ui-button[variant="primary"]')?.click();
};
export const EditProjectError: Story = { render:() => view('chat-editor',false,false,false,true), play:showEditProjectError };
export const PhoneEditProjectError: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true,false,false,true), play:showEditProjectError };
const openProjectFolderBrowser = async (context: {canvasElement:HTMLElement}) => {
  await openProjectEditor(context);
  const list = context.canvasElement.querySelector<MuxChatList>('mux-chat-list');
  const project = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'atlas');
  await project?.updateComplete;
  await project?.shadowRoot?.querySelector<MuxUIDialog>('mux-ui-dialog')?.updateComplete;
  project?.shadowRoot?.querySelector<HTMLElement>('mux-ui-button[accessible-label="Browse primary folders"]')?.click();
  for (let attempt=0; attempt<20; attempt++) {
    await project?.updateComplete;
    if (project?.shadowRoot?.querySelector('mux-ui-folder-browser')) return;
    await new Promise(resolve => setTimeout(resolve,50));
  }
  throw new Error('The project folder browser did not open');
};
export const EditProjectFolderBrowser: Story = { play:openProjectFolderBrowser };
export const PhoneEditProjectFolderBrowser: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true),play:openProjectFolderBrowser };
const openProjectRemoval = async ({canvasElement}: {canvasElement: HTMLElement}) => {
  const list = canvasElement.querySelector<MuxChatList>('mux-chat-list');
  await list?.updateComplete;
  const project = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'atlas');
  project?.shadowRoot?.querySelector<MuxUIButton>('mux-ui-button[accessible-label="Project options for Atlas"]')?.click();
  await project?.updateComplete;
  [...(project?.shadowRoot?.querySelectorAll<MuxUIMenuItem>('mux-ui-menu-item') ?? [])].find(item => item.textContent?.includes('Remove project'))?.click();
};
export const RemoveProjectConfirmation: Story = { play:openProjectRemoval };
export const PhoneRemoveProjectConfirmation: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true), play:openProjectRemoval };
export const LinkedLaneArchiveConfirmation: Story = {
  render:() => view('chat-editor',false,false,true),
  play:async ({canvasElement}) => {
    const list = canvasElement.querySelector<MuxChatList>('mux-chat-list');
    await list?.updateComplete;
    const project = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'atlas');
    const row = [...(project?.shadowRoot?.querySelectorAll<HTMLElement>('.chat-row') ?? [])].find(node => node.querySelector<MuxUIListRow>('mux-ui-list-row')?.label === 'Build and deployment logs');
    row?.querySelector<MuxUIButton>('mux-ui-button[accessible-label="Options for Build and deployment logs"]')?.click();
    await project?.updateComplete;
    [...(row?.querySelectorAll<MuxUIMenuItem>('mux-ui-menu-item') ?? [])].find(item => item.textContent?.includes('Archive chat'))?.click();
  },
};
