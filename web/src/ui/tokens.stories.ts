import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './feedback.js';

const colorTokens = [
  ['Surface', '--ui-surface-base'],
  ['Raised surface', '--ui-surface-raised'],
  ['Navigation surface', '--ui-surface-nav'],
  ['Hover surface', '--ui-surface-hover'],
  ['Overlay surface', '--ui-surface-overlay'],
  ['Border', '--ui-border'],
  ['Strong border', '--ui-border-strong'],
  ['Text', '--ui-text'],
  ['Muted text', '--ui-text-muted'],
  ['Accent', '--ui-accent'],
  ['Danger', '--ui-danger'],
  ['Danger text', '--ui-danger-text'],
  ['Success', '--ui-success'],
  ['Warning', '--ui-warning'],
  ['Attention', '--ui-attention'],
  ['Document surface', '--ui-document-surface'],
  ['Document text', '--ui-document-text'],
  ['Document muted', '--ui-document-muted'],
  ['Document accent', '--ui-document-accent'],
  ['Document border', '--ui-document-border'],
  ['Document hover', '--ui-document-hover'],
] as const;

const layerTokens = [
  ['Local content', '--ui-z-local', 2],
  ['Screen', '--ui-z-screen', 4],
  ['Drawer', '--ui-z-drawer', 5],
  ['Utility rail', '--ui-z-utility', 6],
  ['Drag overlay', '--ui-z-drag-overlay', 10],
  ['Dropdown', '--ui-z-dropdown', 20],
  ['Menu', '--ui-z-menu', 30],
  ['Window chrome', '--ui-z-window-chrome', 50],
  ['Side panel', '--ui-z-side-panel', 60],
  ['Phone sheet', '--ui-z-sheet', 70],
  ['Toast', '--ui-z-toast', 950],
  ['Connection overlay', '--ui-z-connection-overlay', 1000],
  ['Reconnect overlay', '--ui-z-reconnect-overlay', 2000],
  ['Alert stack', '--ui-z-alert-stack', 2500],
  ['Settings page', '--ui-z-settings-page', 3000],
] as const;

const meta = {
  title: 'Foundations/Tokens',
  tags: ['autodocs'],
  render: () => html`
    <section style="max-width:780px">
      <h1 style="font-size:var(--ui-text-3xl);margin:0 0 var(--ui-space-4)">Muxterm tokens</h1>
      <p style="color:var(--ui-text-muted);margin:0 0 var(--ui-space-8)">Change the palette in the toolbar. Components inherit these semantic values through shadow roots.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:var(--ui-space-5)">
        ${colorTokens.map(([label, token]) => html`<div style="border:1px solid var(--ui-border);border-radius:var(--ui-radius-lg);overflow:hidden;background:var(--ui-surface-raised)">
          <div style=${`height:64px;background:var(${token})`}></div>
          <div style="padding:var(--ui-space-5);font-size:var(--ui-text-sm)"><strong>${label}</strong><div style="color:var(--ui-text-muted);font:var(--ui-text-xs) var(--ui-font-mono)">${token}</div></div>
        </div>`)}
      </div>
      <h2 style="font-size:var(--ui-text-2xl);margin:var(--ui-space-9) 0 var(--ui-space-5)">Control scale</h2>
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:var(--ui-space-6)">
        <span style="height:var(--ui-control-sm);display:grid;place-items:center;border:1px solid var(--ui-border);padding:0 var(--ui-space-5);border-radius:var(--ui-radius-md)">Small · 28</span>
        <span style="height:var(--ui-control-md);display:grid;place-items:center;border:1px solid var(--ui-border);padding:0 var(--ui-space-5);border-radius:var(--ui-radius-md)">Medium · 36</span>
        <span style="height:var(--ui-control-lg);display:grid;place-items:center;border:1px solid var(--ui-border);padding:0 var(--ui-space-5);border-radius:var(--ui-radius-md)">Large · 44</span>
        <span style="height:var(--ui-nav-height);display:grid;place-items:center;border:1px solid var(--ui-border);padding:0 var(--ui-space-5);border-radius:var(--ui-radius-md)">Navigation row</span>
        <span style="height:var(--ui-row-touch);display:grid;place-items:center;border:1px solid var(--ui-border);padding:0 var(--ui-space-5);border-radius:var(--ui-radius-md)">Touch row · 56</span>
      </div>
      <h2 style="font-size:var(--ui-text-2xl);margin:var(--ui-space-9) 0 var(--ui-space-5)">Shape and elevation</h2>
      <div style="display:flex;flex-wrap:wrap;gap:var(--ui-space-8)">
        <div style="padding:var(--ui-space-8);border:1px solid var(--ui-border);border-radius:var(--ui-radius-md);background:var(--ui-surface-overlay);box-shadow:var(--ui-shadow-menu)">Menu surface</div>
        <div style="padding:var(--ui-space-8);border:1px solid var(--ui-border);border-radius:var(--ui-radius-xl);background:var(--ui-surface-overlay);box-shadow:var(--ui-shadow-overlay)">Overlay surface</div>
        <div style="position:relative;overflow:hidden;padding:var(--ui-space-8);border:1px solid var(--ui-border);border-radius:var(--ui-radius-xl);background:var(--ui-surface-base)">
          <div style="position:absolute;inset:0;background:var(--ui-backdrop-sheet)"></div>
          <div style="position:relative;padding:var(--ui-space-4);border:1px solid var(--ui-border-strong);border-radius:var(--ui-radius-lg);background:var(--ui-surface-raised);box-shadow:var(--ui-shadow-sheet)">Sheet and tinted backdrop</div>
        </div>
        <mux-ui-feedback kind="error" appearance="panel" align="center" style="min-width:var(--ui-toast-min-width);box-shadow:var(--ui-shadow-menu)">Toast feedback surface</mux-ui-feedback>
      </div>
      <h2 style="font-size:var(--ui-text-2xl);margin:var(--ui-space-9) 0 var(--ui-space-5)">Layer order</h2>
      <p style="color:var(--ui-text-muted);margin:0 0 var(--ui-space-5)">Local layers share a screen context. App-wide layers sit above screens. Modal dialogs use the browser top layer.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:var(--ui-space-4)">
        ${layerTokens.map(([label, token, value]) => html`<div style="padding:var(--ui-space-5);border:1px solid var(--ui-border);border-radius:var(--ui-radius-md);background:var(--ui-surface-raised)"><strong>${label}</strong><div style="color:var(--ui-text-muted);font:var(--ui-text-xs) var(--ui-font-mono)">${token}: ${value}</div></div>`)}
      </div>
    </section>`,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;
export const SemanticScale: Story = {};
