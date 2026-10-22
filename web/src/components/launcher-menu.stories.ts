import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './launcher-menu.js';

interface LauncherArgs { showCreateWorkspace: boolean }
const meta = {
  title: 'Navigation/Launcher menu',
  tags: ['autodocs'],
  args: { showCreateWorkspace:false },
  render: (args: LauncherArgs) => html`<div style="width:220px"><mux-launcher-menu .showCreateWorkspace=${args.showCreateWorkspace}></mux-launcher-menu></div>`,
} satisfies Meta<LauncherArgs>;

export default meta;
type Story = StoryObj<LauncherArgs>;
export const Desktop: Story = {};
export const WithWorkspaceAction: Story = { args: { showCreateWorkspace:true } };
export const MobileSheet: Story = {
  render: () => html`<button popovertarget="story-launcher-sheet" style="min-height:44px;padding:0 12px;background:var(--ui-surface-raised);border:1px solid var(--ui-border);border-radius:var(--ui-radius-md);color:var(--ui-text)">Open menu</button><mux-launcher-menu id="story-launcher-sheet" sheet popover="auto" .showCreateWorkspace=${true}></mux-launcher-menu>`,
};
