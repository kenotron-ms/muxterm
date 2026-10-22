import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { Folder, FolderOpen, MessageSquare, PinOff } from 'lucide';
import { icon } from '../lib/icons.js';
import type { MuxUIListRow } from './list-row.js';
import './list-row.js';
import './button.js';

const frame = (content: ReturnType<typeof html>) => html`<div style="box-sizing:border-box;width:320px;max-width:100vw;padding:var(--ui-space-4);background:var(--ui-surface-nav);color:var(--ui-text)">${content}</div>`;

const meta = {
  title:'Foundations/Navigation/List row', tags:['autodocs'],
  render:() => frame(html`<mux-ui-list-row label="Build and deployment logs" tooltip="Build and deployment logs · /home/ken/project"><span slot="icon">${icon(MessageSquare,{size:15})}</span></mux-ui-list-row>`),
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Chat: Story = {};
export const SelectedChat: Story = { render:() => frame(html`<mux-ui-list-row label="Build and deployment logs" selected><span slot="icon">${icon(MessageSquare,{size:15})}</span></mux-ui-list-row>`) };
export const ProjectDisclosure: Story = {
  render:() => frame(html`<mux-ui-list-row variant="group" label="Atlas" expandable expanded @click=${(event:Event) => { const row=event.currentTarget as MuxUIListRow; row.expanded=!row.expanded; }}><span slot="icon">${icon(FolderOpen,{size:16})}</span></mux-ui-list-row>`),
};
export const ArchivedGroup: Story = { render:() => frame(html`<mux-ui-list-row variant="group" label="Archived" expandable muted><span slot="icon">${icon(Folder,{size:16})}</span></mux-ui-list-row>`) };
export const WithSiblingAction: Story = { render:() => frame(html`<div style="display:flex;align-items:center;border-radius:var(--ui-radius-md);background:var(--ui-nav-selected)"><mux-ui-list-row label="Pinned chat" selected><span slot="icon">${icon(MessageSquare,{size:15})}</span></mux-ui-list-row><mux-ui-button icon-only size="small" variant="quiet" accessible-label="Unpin chat">${icon(PinOff,{size:14})}</mux-ui-button></div>`) };
export const Phone: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:WithSiblingAction.render };
export const Light: Story = { globals:{palette:'github-light'},render:WithSiblingAction.render };
export const KeyboardFocus: Story = {
  render:WithSiblingAction.render,
  play:async ({canvasElement}) => { canvasElement.querySelector<MuxUIListRow>('mux-ui-list-row')?.focus(); },
};
