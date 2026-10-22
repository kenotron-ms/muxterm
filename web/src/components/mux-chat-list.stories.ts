import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { chatListFixture, resetChatListFixture } from '../stories/chat-list-fixture.js';
import type { MuxChatList, MuxChatWorkspace } from './mux-chat-list.js';
import './mux-chat-list.js';

function view(selectedSession = 'chat-editor', phone = false, empty = false) {
  resetChatListFixture(empty);
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
export const Empty: Story = { render:() => view('',false,true) };
export const AnotherSelectedChat: Story = { render:() => view('chat-notes') };
export const ArchivedExpanded: Story = { play:async ({canvasElement}) => {
  const list = canvasElement.querySelector<MuxChatList>('mux-chat-list');
  await list?.updateComplete;
  const archived = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'archived');
  archived?.shadowRoot?.querySelector<HTMLButtonElement>('.group')?.click();
} };
export const ArchivedChatMenu: Story = { play:async ({canvasElement}) => {
  const list = canvasElement.querySelector<MuxChatList>('mux-chat-list');
  await list?.updateComplete;
  const archived = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'archived');
  archived?.shadowRoot?.querySelector<HTMLButtonElement>('.group')?.click();
  await archived?.updateComplete;
  archived?.shadowRoot?.querySelector<HTMLButtonElement>('.chat-row .action.more')?.click();
} };
export const PhoneList: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true) };
export const PhoneArchivedExpanded: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true), play:ArchivedExpanded.play };
const openProjectEditor = async ({canvasElement}: {canvasElement: HTMLElement}) => {
  const list = canvasElement.querySelector<MuxChatList>('mux-chat-list');
  await list?.updateComplete;
  const project = [...(list?.shadowRoot?.querySelectorAll<MuxChatWorkspace>('mux-chat-workspace') ?? [])].find(row => row.model.id === 'atlas');
  project?.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Edit Atlas"]')?.click();
};
export const EditProject: Story = { play:openProjectEditor };
export const PhoneEditProject: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view('chat-editor',true), play:openProjectEditor };
