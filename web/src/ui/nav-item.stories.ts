import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { icon } from '../lib/icons.js';
import { CalendarClock, Plug, Plus, SquareTerminal } from 'lucide';
import './nav-item.js';

const view = (selected: string) => html`<nav aria-label="Example destinations" style="box-sizing:border-box;width:320px;padding:var(--ui-space-4);background:var(--ui-surface-nav);border:1px solid var(--ui-border);border-radius:var(--ui-radius-lg)">
  <mux-ui-nav-item label="New Chat" ?active=${selected === 'New Chat'}><span slot="icon">${icon(Plus,{size:17})}</span></mux-ui-nav-item>
  <mux-ui-nav-item label="Terminal" ?active=${selected === 'Terminal'}><span slot="icon">${icon(SquareTerminal,{size:16})}</span></mux-ui-nav-item>
  <mux-ui-nav-item label="Scheduled jobs" ?active=${selected === 'Scheduled jobs'}><span slot="icon">${icon(CalendarClock,{size:14})}</span></mux-ui-nav-item>
  <mux-ui-nav-item label="Connections" ?active=${selected === 'Connections'}><span slot="icon">${icon(Plug,{size:14})}</span></mux-ui-nav-item>
</nav>`;

const meta = { title:'Primitives/Navigation item', tags:['autodocs'], render:() => view('New Chat') } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Selected: Story = {};
export const AnotherDestination: Story = { render:() => view('Connections') };
export const KeyboardFocus: Story = { render:() => view('Terminal'), play:async ({canvasElement}) => {
  canvasElement.querySelector<HTMLElement>('mux-ui-nav-item[label="Scheduled jobs"]')?.focus();
} };
export const DescriptionsAndStatus: Story = { render:() => html`<nav aria-label="Connection services" style="box-sizing:border-box;width:300px;padding:var(--ui-space-4);background:var(--ui-surface-nav)">
  <mux-ui-nav-item label="GitHub" .description=${'Repositories, issues, and pull requests'} status-tone="success" status-label="Ready" active></mux-ui-nav-item>
  <mux-ui-nav-item label="OneDrive" description="Files from your personal Microsoft account" status-tone="neutral" status-label="Not connected"></mux-ui-nav-item>
  <mux-ui-nav-item label="Documentation" description="Sign in again to refresh access" status-tone="warning" status-label="Needs attention"></mux-ui-nav-item>
</nav>` };
export const SectionRail: Story = { render:() => html`<nav aria-label="Settings sections" style="box-sizing:border-box;width:180px;padding:var(--ui-space-4) 0;background:var(--ui-surface-base);border:1px solid var(--ui-border)">
  <mux-ui-nav-item variant="section" label="Appearance" active></mux-ui-nav-item>
  <mux-ui-nav-item variant="section" label="Notifications"></mux-ui-nav-item>
  <mux-ui-nav-item variant="section" label="Workspaces"></mux-ui-nav-item>
  <mux-ui-nav-item variant="section" label="Keyboard Shortcuts"></mux-ui-nav-item>
</nav>` };
