import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './pane-divider.js';

const meta = {
  title: 'UI/Pane Divider',
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen', fullBleed: true },
  render: () => html`
    <div style="display:grid;gap:24px;padding:32px;background:var(--ui-surface-base);color:var(--ui-text);font:var(--ui-text-md) var(--ui-font-sans)">
      <div>Every pane seam occupies one pixel, with a transparent resize target extending to either side.</div>
      <div style="display:grid;grid-template-columns:32% var(--ui-divider-thickness) minmax(0,1fr);height:100px;border:1px solid var(--ui-border)">
        <section style="background:var(--ui-surface-raised);padding:16px">Sidebar</section>
        <mux-ui-pane-divider role="separator" aria-label="Resize sidebar" aria-orientation="vertical"></mux-ui-pane-divider>
        <section style="background:var(--ui-surface-base);padding:16px">Main pane</section>
      </div>
      <div style="display:flex;height:220px;border:1px solid var(--ui-border)">
        <section style="flex:1;background:var(--ui-surface-base);padding:16px">Chat pane</section>
        <mux-ui-pane-divider role="separator" aria-label="Resize utility pane" aria-orientation="vertical" tabindex="0"></mux-ui-pane-divider>
        <section style="flex:1;background:var(--ui-surface-raised);padding:16px">Utility pane</section>
      </div>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) var(--ui-divider-thickness) 32%;height:220px;border:1px solid var(--ui-border)">
        <section style="background:var(--ui-surface-base);padding:16px">File viewer</section>
        <mux-ui-pane-divider role="separator" aria-label="Resize file explorer" aria-orientation="vertical" tabindex="0"></mux-ui-pane-divider>
        <section style="background:var(--ui-surface-base);padding:16px">Explorer rail</section>
      </div>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) var(--ui-divider-thickness) 32%;height:100px;border:1px solid var(--ui-border)">
        <section style="padding:16px">Meeting viewer</section>
        <mux-ui-pane-divider fixed aria-hidden="true"></mux-ui-pane-divider>
        <section style="padding:16px">Context rail</section>
      </div>
    </div>
  `,
} satisfies Meta;
export default meta;
type Story = StoryObj;

export const Default: Story = {};
export const Light: Story = { globals: { palette: 'github-light' } };
export const MistLight: Story = { globals: { palette: 'github-light', appTheme: 'mist', appMode: 'light' } };
export const CoralLight: Story = { globals: { palette: 'github-light', appTheme: 'coral', appMode: 'light' } };
