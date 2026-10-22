import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './attachment.js';

const meta = {
  title: 'Components/Attachment',
  tags: ['autodocs'],
  render: () => html`<mux-ui-attachment file-name="project-notes.txt"></mux-ui-attachment>`,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Uploading: Story = { render: () => html`<mux-ui-attachment file-name="design-review.md" state="uploading"></mux-ui-attachment>` };
export const Failed: Story = { render: () => html`<mux-ui-attachment file-name="notes.txt" state="error" error="The file could not be uploaded. Try attaching it again."></mux-ui-attachment>` };
export const ImagePreview: Story = { render: () => html`<mux-ui-attachment file-name="muxterm-preview.svg" preview-url="/icons/icon.svg"></mux-ui-attachment>` };
export const LongName: Story = { render: () => html`<mux-ui-attachment file-name="2026-10-22-component-library-review-and-feedback-notes.md"></mux-ui-attachment>` };
export const Phone: Story = { globals: { viewport: { value: 'phone390', isRotated: false } }, render: () => html`<div style="display:flex;flex-wrap:wrap;gap:var(--ui-space-4);width:100%"><mux-ui-attachment file-name="project-notes.txt"></mux-ui-attachment><mux-ui-attachment file-name="image-preview.svg" preview-url="/icons/icon.svg" state="uploading"></mux-ui-attachment></div>` };
export const Light: Story = { globals: { palette: 'github-light' } };
export const KeyboardFocus: Story = {
  play: async ({ canvasElement }) => { canvasElement.querySelector('mux-ui-attachment')?.shadowRoot?.querySelector<HTMLElement>('mux-ui-button')?.focus(); },
};
