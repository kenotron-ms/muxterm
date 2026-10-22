import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './menu.js';

const meta = {
  title:'Components/Action Menu', tags:['autodocs'],
  parameters:{layout:'fullscreen'},
  render:() => html`<div style="position:relative;min-height:360px;padding:var(--ui-space-7);background:var(--ui-surface-nav)">
    <button style="padding:var(--ui-space-4);border:1px solid var(--ui-border);border-radius:var(--ui-radius-md);background:var(--ui-surface-raised);color:var(--ui-text)">Project options</button>
    <mux-ui-menu label="Project actions" style="--ui-menu-offset-y:var(--ui-space-11);--ui-menu-offset-x:auto;left:var(--ui-space-7)">
      <button role="menuitem">New chat</button>
      <button role="menuitem">Edit project and folders</button>
      <div role="separator"></div>
      <button role="menuitem" class="danger">Remove project</button>
    </mux-ui-menu>
  </div>`,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Actions: Story = {};
export const PhoneSheet: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
