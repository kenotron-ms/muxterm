import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './menu.js';
import './button.js';

const meta = {
  title:'Components/Action Menu', tags:['autodocs'],
  parameters:{layout:'fullscreen'},
  render:() => html`<div style="position:relative;min-height:360px;padding:var(--ui-space-7);background:var(--ui-surface-nav)">
    <mux-ui-button variant="secondary">Project options</mux-ui-button>
    <mux-ui-menu label="Project actions" style="--ui-menu-offset-y:var(--ui-space-11);--ui-menu-offset-x:auto;left:var(--ui-space-7)">
      <mux-ui-menu-item>New chat</mux-ui-menu-item>
      <mux-ui-menu-item>Edit project and folders</mux-ui-menu-item>
      <div role="separator"></div>
      <mux-ui-menu-item tone="danger">Remove project</mux-ui-menu-item>
    </mux-ui-menu>
  </div>`,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Actions: Story = {};
export const PhoneSheet: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
