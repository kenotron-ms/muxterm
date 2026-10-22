import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { homeSessions } from '../lib/home-sessions.js';
import { FIXTURE_SESSIONS } from '../lib/session-state.js';
import { MuxStore } from '../state.js';
import { SessiondType } from '../types.js';
import { createVoiceFixture } from '../stories/voice-fixture.js';
import type { MuxTitleBar } from './title-bar.js';
import './title-bar.js';

type State = {
  attention?: boolean;
  chatTitle?: string;
  desktop?: boolean;
  drawerOpen?: boolean;
  showLauncher?: boolean;
  filesOpen?: boolean;
};

function paneFixture(): MuxStore {
  const fixture = new MuxStore();
  fixture.applySessiond({
    type: SessiondType.WorkspaceList,
    workspaces: [{ workspaceId: 'story-workspace', name: 'Atlas', paneCount: 1 }],
  });
  fixture.applySessiond({
    type: SessiondType.Composition,
    workspaceId: 'story-workspace',
    panes: [{ paneId: 1, title: 'Terminal', cols: 80, rows: 24 }],
    layout: '',
  });
  return fixture;
}

function view(state: State = {}) {
  homeSessions.set(state.attention ? FIXTURE_SESSIONS.slice(0, 1) : [], 'fixture');
  const paneStore = paneFixture();
  const voiceController = createVoiceFixture();
  return html`<div style="min-height:100dvh;background:var(--ui-surface-base)">
    <mux-title-bar
      .paneStore=${paneStore}
      .voiceController=${voiceController}
      .chatTitle=${state.chatTitle ?? ''}
      .desktop=${state.desktop ?? false}
      .drawerOpen=${state.drawerOpen ?? false}
      .showLauncher=${state.showLauncher ?? true}
      .terminalActive=${!state.desktop && !state.chatTitle}
      .filesOpen=${state.filesOpen ?? false}
      @drawer-toggle=${(event: Event) => { const bar = event.currentTarget as MuxTitleBar; bar.drawerOpen = !bar.drawerOpen; }}
      @file-explorer-toggle=${(event: Event) => { const bar = event.currentTarget as MuxTitleBar; bar.filesOpen = !bar.filesOpen; }}
    ></mux-title-bar>
  </div>`;
}

const meta = {
  title: 'Composites/Title bar',
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen', fullBleed: true },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => view(),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const MobileWorkspace: Story = {};
export const DrawerOpen: Story = { render: () => view({ drawerOpen: true }) };
export const NeedsAttention: Story = { render: () => view({ attention: true }) };
export const FilesOpen: Story = { render: () => view({ filesOpen: true }) };
export const LightWorkspace: Story = { globals: { palette: 'github-light' } };
export const ChatTitle: Story = { render: () => view({ chatTitle: 'Build pipeline notes' }) };
export const NewChatTitle: Story = { render: () => view({ chatTitle: 'New Chat', showLauncher: false }) };
export const SettingsAction: Story = {
  play: async ({ canvasElement }) => {
    canvasElement.querySelector('mux-title-bar')?.shadowRoot?.querySelector<HTMLElement>('mux-ui-button[accessible-label="Open settings"]')?.focus();
  },
};
export const DesktopEmptyWorkspace: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  render: () => view({ desktop: true }),
};
