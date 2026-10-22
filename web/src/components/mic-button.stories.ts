import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { createVoiceFixture } from '../stories/voice-fixture.js';
import { MuxStore } from '../state.js';
import { SessiondType } from '../types.js';
import type { MuxMicButton } from './mic-button.js';
import './mic-button.js';

type State = { pane?: boolean; listening?: boolean; failOnStart?: boolean; supported?: boolean };

function view(state: State = {}) {
  const paneStore = new MuxStore();
  const panes = state.pane === false ? [] : [{ paneId: 1, title: 'Terminal', cols: 80, rows: 24 }];
  paneStore.applySessiond({
    type: SessiondType.WorkspaceList,
    workspaces: [{ workspaceId: 'story-workspace', name: 'Atlas', paneCount: panes.length }],
  });
  paneStore.applySessiond({ type: SessiondType.Composition, workspaceId: 'story-workspace', panes, layout: '' });
  const voiceController = createVoiceFixture({
    state: state.listening ? 'listening' : 'idle',
    failOnStart: state.failOnStart,
    supported: state.supported,
  });
  return html`<div style="display:flex;align-items:center;gap:var(--ui-space-5);width:max-content;padding:var(--ui-space-5);border:1px solid var(--ui-border);border-radius:var(--ui-radius-lg);background:var(--ui-surface-nav)">
    <span>Terminal dictation</span>
    <mux-mic-button .paneStore=${paneStore} .voiceController=${voiceController}></mux-mic-button>
  </div>`;
}

const meta = {
  title: 'Composites/Microphone button',
  tags: ['autodocs'],
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => view(),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Listening: Story = { render: () => view({ listening: true }) };
export const NoPane: Story = { render: () => view({ pane: false }) };
export const FirstPaneArrives: Story = {
  render: () => view({ pane: false }),
  play: async ({ canvasElement }) => {
    const mic = canvasElement.querySelector<MuxMicButton>('mux-mic-button');
    mic?.paneStore.applySessiond({ type: SessiondType.PaneAdded, paneId: 1, title: 'Terminal', cols: 80, rows: 24 });
  },
};
export const ErrorToast: Story = {
  render: () => view({ failOnStart: true }),
  play: async ({ canvasElement }) => {
    const mic = canvasElement.querySelector<MuxMicButton>('mux-mic-button');
    await mic?.updateComplete;
    const button = mic?.shadowRoot?.querySelector('mux-ui-button');
    await button?.updateComplete;
    button?.click();
  },
};
export const Unsupported: Story = { render: () => view({ supported: false }) };
