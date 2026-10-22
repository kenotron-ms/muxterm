import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { FolderOpen, NotebookPen } from 'lucide';
import { icon } from '../lib/icons.js';
import './button.js';
import './empty-state.js';
import './feedback.js';
import './menu.js';
import './page-intro.js';
import './status-badge.js';
import './text-field.js';

type ThemeScheme = 'violet' | 'ocean' | 'sand';
interface ThemeLabArgs { scheme: ThemeScheme; backdrop: boolean }

// Keep these overrides scoped to the story so the toolbar palette and other stories stay independent.
const themeSchemes: Record<ThemeScheme, string> = {
  violet: `--ui-surface-base:#171725;--ui-surface-raised:#232338;--ui-surface-nav:#1d1d30;--ui-surface-hover:#30304a;--ui-surface-overlay:#232338;--ui-border:#4b4b68;--ui-text:#f6f2ff;--ui-text-muted:#c0bad1;--ui-accent:#c8a4ff;--ui-on-accent:#1c1329;--ui-focus:#d8bdff;--ui-document-surface:#fffaf2;--ui-document-text:#28202b;--ui-document-muted:#635969;--ui-document-accent:#7043a2;--ui-document-border:#dfd1dd;--ui-document-hover:#f2e9f0;`,
  ocean: `--ui-surface-base:#09262c;--ui-surface-raised:#123840;--ui-surface-nav:#0d3037;--ui-surface-hover:#1b4c54;--ui-surface-overlay:#123840;--ui-border:#3e6970;--ui-text:#effcf9;--ui-text-muted:#b7d5d4;--ui-accent:#75e7d1;--ui-on-accent:#06322e;--ui-focus:#8af4e0;--ui-document-surface:#f1faf7;--ui-document-text:#163b3b;--ui-document-muted:#526b6b;--ui-document-accent:#126f67;--ui-document-border:#c8ddda;--ui-document-hover:#dff0eb;`,
  sand: `--ui-surface-base:#f5efe3;--ui-surface-raised:#fffaf0;--ui-surface-nav:#eee3d2;--ui-surface-hover:#e9dcc8;--ui-surface-overlay:#fffaf0;--ui-border:#cbbca7;--ui-text:#30291f;--ui-text-muted:#685b4c;--ui-accent:#874a28;--ui-on-accent:#fff8ec;--ui-focus:#995837;--ui-document-surface:#fffdf8;--ui-document-text:#30291f;--ui-document-muted:#695c4d;--ui-document-accent:#874a28;--ui-document-border:#dacdbb;--ui-document-hover:#f1e8d8;`,
};

const meta = {
  title: 'Foundations/Theme Lab',
  tags: ['autodocs'],
  args: { scheme: 'violet', backdrop: true },
  argTypes: { scheme: { control: 'select', options: ['violet', 'ocean', 'sand'] } },
  parameters: { layout: 'fullscreen', fullBleed: true },
  render: (args: ThemeLabArgs) => {
    const backdrop = args.backdrop
      ? '--ui-app-backdrop-image:radial-gradient(circle at 85% 5%,color-mix(in srgb,var(--ui-accent) 24%,transparent),transparent 45%);--ui-overlay-backdrop-image:linear-gradient(135deg,color-mix(in srgb,var(--ui-accent) 12%,transparent),transparent 75%);'
      : '--ui-app-backdrop-image:none;--ui-overlay-backdrop-image:none;';
    return html`<div style=${`${themeSchemes[args.scheme]}${backdrop}min-height:100vh;box-sizing:border-box;background:var(--ui-surface-base);background-image:var(--ui-app-backdrop-image);color:var(--ui-text);font:var(--ui-text-md)/1.5 var(--ui-font-sans)`}>
      <mux-ui-page-intro eyebrow="Theme lab" heading="Project workspace" description="Semantic tokens flow into app, overlay, and document surfaces.">
        <mux-ui-button slot="action" variant="primary">New chat</mux-ui-button>
      </mux-ui-page-intro>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:var(--ui-space-6);max-width:960px;margin:auto;padding:var(--ui-space-7)">
        <section style="display:grid;align-content:start;gap:var(--ui-space-6);padding:var(--ui-space-6);border:1px solid var(--ui-border);border-radius:var(--ui-radius-xl);background:var(--ui-surface-raised)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--ui-space-4)"><strong>Controls and feedback</strong><mux-ui-status-badge tone="success" dot>Connected</mux-ui-status-badge></div>
          <mux-ui-text-field label="Project name" value="Studio" description="Visible in the workspace list"></mux-ui-text-field>
          <div style="display:flex;flex-wrap:wrap;gap:var(--ui-space-4)"><mux-ui-button variant="primary">Save changes</mux-ui-button><mux-ui-button variant="secondary">Cancel</mux-ui-button></div>
          <mux-ui-feedback kind="info" appearance="panel">Your changes sync across devices.</mux-ui-feedback>
        </section>
        <section style="display:flex;flex-direction:column;min-height:330px;border:1px solid var(--ui-document-border);border-radius:var(--ui-radius-xl);background:var(--ui-document-surface);color:var(--ui-document-text)">
          <div style="padding:var(--ui-space-5) var(--ui-space-6);border-bottom:1px solid var(--ui-document-border);font-weight:650">Pages</div>
          <mux-ui-empty-state appearance="document" heading="Start a page">
            <span slot="icon">${icon(NotebookPen, { size: 24 })}</span>
            Write notes and plans alongside your chats.
            <mux-ui-button slot="action" appearance="document" variant="secondary">New page</mux-ui-button>
          </mux-ui-empty-state>
        </section>
        <section style="position:relative;min-height:210px;padding:var(--ui-space-6);border:1px solid var(--ui-border);border-radius:var(--ui-radius-xl);background:var(--ui-surface-nav)">
          <strong>Overlay surface</strong>
          <p style="max-width:34ch;color:var(--ui-text-muted)">Menus inherit the selected palette and optional backdrop treatment.</p>
          <div style="position:relative;min-height:120px"><mux-ui-menu label="Project actions" style="--ui-menu-offset-y:var(--ui-space-2);--ui-menu-offset-x:auto;left:0">
            <mux-ui-menu-item>${icon(FolderOpen, { size: 16 })} Open project</mux-ui-menu-item>
            <mux-ui-menu-item>Edit project</mux-ui-menu-item>
          </mux-ui-menu></div>
        </section>
      </div>
    </div>`;
  },
} satisfies Meta<ThemeLabArgs>;

export default meta;
type Story = StoryObj<ThemeLabArgs>;
export const CustomPalette: Story = {};
export const PhonePalette: Story = { globals: { viewport: { value: 'phone390', isRotated: false } } };
export const LightPalette: Story = { args: { scheme: 'sand' } };
