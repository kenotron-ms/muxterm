import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { FolderOpen, GitCompare, NotebookPen } from 'lucide';
import { icon } from '../lib/icons.js';
import './empty-state.js';
import './button.js';

const meta = {
  title: 'Patterns/Empty State',
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const WithAction: Story = {
  render: () => html`<div style="display:flex;width:min(540px,calc(100vw - 96px));height:380px;background:var(--ui-surface-base)">
    <mux-ui-empty-state heading="Explore this project">
      <span slot="icon">${icon(FolderOpen, { size: 24 })}</span>
      Choose a file from the explorer or search by name across the project.
      <mux-ui-button slot="action" variant="secondary">Quick Open</mux-ui-button>
    </mux-ui-empty-state>
  </div>`,
};

export const NoAction: Story = {
  render: () => html`<div style="display:flex;width:min(540px,calc(100vw - 96px));height:380px;background:var(--ui-surface-base)">
    <mux-ui-empty-state heading="Review project changes">
      <span slot="icon">${icon(GitCompare, { size: 24 })}</span>
      Select a file to compare it with HEAD.
    </mux-ui-empty-state>
  </div>`,
};

export const Document: Story = {
  render: () => html`<div style="display:flex;width:min(540px,calc(100vw - 96px));height:380px;background:var(--ui-document-surface)">
    <mux-ui-empty-state heading="Pages" appearance="document">
      <span slot="icon">${icon(NotebookPen, { size: 24 })}</span>
      Create a document for this chat.
      <mux-ui-button slot="action" appearance="document" variant="secondary">New page</mux-ui-button>
    </mux-ui-empty-state>
  </div>`,
};

export const PhoneDocument: Story = {
  ...Document,
  globals: { viewport: { value: 'phone390', isRotated: false } },
};

export const LightApp: Story = {
  ...WithAction,
  globals: { palette: 'github-light' },
};
