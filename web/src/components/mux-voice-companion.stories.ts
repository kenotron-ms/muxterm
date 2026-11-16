import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import type { MuxVoiceCompanion, VoiceEntry } from './mux-voice-companion.js';
import './mux-voice-companion.js';

const entries: VoiceEntry[] = [
  { role: 'user', text: 'Ask the task chat to check the release.' },
  { role: 'assistant', text: 'I’ll send that to the task chat.' },
  { role: 'task', text: 'Check the release status and report back.' },
  { role: 'assistant', text: 'The task chat is checking it now.' },
];

function view(active: boolean) {
  return html`<div style="height:550px;width:360px;border:1px solid var(--ui-border)">
    <mux-voice-companion .entries=${entries} .voiceState=${active ? 'listening' : 'idle'}
      .startedAt=${active ? Date.now() - 13_000 : 0} .available=${true}></mux-voice-companion>
  </div>`;
}

const meta = {
  title: 'Composites/Voice companion',
  tags: ['autodocs'],
  render: () => view(true),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Listening: Story = {
  play: async ({ canvasElement }) => {
    const companion = canvasElement.querySelector<MuxVoiceCompanion>('mux-voice-companion');
    await companion?.updateComplete;
    companion?.setLevels([0.3, 0.8, 0.5, 0.7]);
  },
};
export const Paused: Story = { render: () => view(false) };
