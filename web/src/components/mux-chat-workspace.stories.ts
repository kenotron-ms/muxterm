import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { chatListFixture, chatListStoryModel, resetChatListFixture } from '../stories/chat-list-fixture.js';
import type { MuxChatWorkspace } from './mux-chat-list.js';
import type { MuxUIButton } from '../ui/button.js';
import './mux-chat-list.js';

function view(phone = false) {
  resetChatListFixture();
  return html`<div style="box-sizing:border-box;width:${phone ? '335px' : '348px'};max-width:100vw;min-height:480px;padding:var(--ui-space-4);background:var(--ui-surface-nav);color:var(--ui-text)">
    <mux-chat-workspace .model=${chatListStoryModel()} .selectedSession=${'chat-editor'}></mux-chat-workspace>
  </div>`;
}

const meta = {
  title:'Composites/Chat project', tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true,apiFixture:chatListFixture},
  render:() => view(),
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ProjectWithChats: Story = {};
export const ProjectMenu: Story = { play:async ({canvasElement}) => {
  const row = canvasElement.querySelector<MuxChatWorkspace>('mux-chat-workspace');
  await row?.updateComplete;
  row?.shadowRoot?.querySelector<MuxUIButton>('.row .action.more')?.click();
} };
export const ChatMenu: Story = { play:async ({canvasElement}) => {
  const row = canvasElement.querySelector<MuxChatWorkspace>('mux-chat-workspace');
  await row?.updateComplete;
  row?.shadowRoot?.querySelector<MuxUIButton>('.chat-row .action.more')?.click();
} };
export const EditProject: Story = { play:async ({canvasElement}) => {
  const row = canvasElement.querySelector<MuxChatWorkspace>('mux-chat-workspace');
  await row?.updateComplete;
  row?.shadowRoot?.querySelector<MuxUIButton>('.row .action.more')?.click();
  await row?.updateComplete;
  [...(row?.shadowRoot?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].find(button => button.textContent?.includes('Edit project and folders'))?.click();
} };
export const RenameProject: Story = { play:async ({canvasElement}) => {
  const row = canvasElement.querySelector<MuxChatWorkspace>('mux-chat-workspace');
  await row?.updateComplete;
  row?.shadowRoot?.querySelector<MuxUIButton>('.row .action.more')?.click();
  await row?.updateComplete;
  [...(row?.shadowRoot?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].find(button => button.textContent?.includes('Rename project'))?.click();
} };
export const RenameChat: Story = { play:async ({canvasElement}) => {
  const row = canvasElement.querySelector<MuxChatWorkspace>('mux-chat-workspace');
  await row?.updateComplete;
  row?.shadowRoot?.querySelector<MuxUIButton>('mux-ui-button[accessible-label="Options for Refine workspace navigation"]')?.click();
  await row?.updateComplete;
  [...(row?.shadowRoot?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].find(button => button.textContent?.includes('Rename chat'))?.click();
} };
export const PhoneProjectMenu: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view(true),play:ProjectMenu.play };
export const PhoneRenameProject: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:() => view(true),play:RenameProject.play };
