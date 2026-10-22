import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { Bot, ChevronRight, Folder, GitCompare, Network, NotebookPen } from 'lucide';
import { icon } from '../lib/icons.js';
import './action-tile.js';
import './status-badge.js';

const grid = () => html`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:var(--ui-space-4);width:min(680px,100%)">
  <mux-ui-action-tile label="Files" description="Browse and preview project files"><span slot="icon">${icon(Folder,{size:18})}</span></mux-ui-action-tile>
  <mux-ui-action-tile label="Status" description="See agent activity"><span slot="icon">${icon(Network,{size:18})}</span></mux-ui-action-tile>
  <mux-ui-action-tile label="Changes" description="Review edits in this project"><span slot="icon">${icon(GitCompare,{size:18})}</span></mux-ui-action-tile>
  <mux-ui-action-tile label="New page" description="Write notes for this chat"><span slot="icon">${icon(NotebookPen,{size:18})}</span></mux-ui-action-tile>
</div>`;

const meta = { title:'Primitives/Action tile', tags:['autodocs'], render:grid } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ToolChoices: Story = {};
export const Phone: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const Light: Story = { globals:{palette:'github-light'} };
export const Disabled: Story = { render:() => html`<div style="width:min(320px,100%)"><mux-ui-action-tile label="Files" description="Browse and preview project files" disabled><span slot="icon">${icon(Folder,{size:18})}</span></mux-ui-action-tile></div>` };
export const KeyboardFocus: Story = { render:() => grid(), play:async ({canvasElement}) => { canvasElement.querySelector<HTMLElement>('mux-ui-action-tile[label="Changes"]')?.focus(); } };
export const DescribedWithStatus: Story = { render:() => html`<div style="width:min(560px,100%)"><mux-ui-action-tile size="large" label="Design review" description="Review the chat controls and report remaining seams" accessible-label="View Design review work, completed">
  <span slot="icon">${icon(Bot,{size:18})}</span><mux-ui-status-badge slot="trailing" tone="success" dot>Completed</mux-ui-status-badge><span slot="trailing" aria-hidden="true">${icon(ChevronRight,{size:16})}</span>
</mux-ui-action-tile></div>` };
