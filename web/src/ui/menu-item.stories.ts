import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './menu.js';
import './button.js';

const meta = {
  title: 'Components/Menu Item',
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  render: () => html`<div style="position:relative;min-height:360px;padding:var(--ui-space-7);background:var(--ui-surface-nav)">
    <mux-ui-button variant="secondary">Project options</mux-ui-button>
    <mux-ui-menu label="Project actions">
      <mux-ui-menu-item>New chat</mux-ui-menu-item>
      <mux-ui-menu-item href="https://example.com/project">Open project site</mux-ui-menu-item>
      <mux-ui-menu-item disabled>Unavailable action</mux-ui-menu-item>
      <div role="separator"></div>
      <mux-ui-menu-item tone="danger">Remove project</mux-ui-menu-item>
    </mux-ui-menu>
  </div>`,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;
export const Actions: Story = {};
export const PhoneSheet: Story = { globals: { viewport: { value: 'phone390', isRotated: false } } };
