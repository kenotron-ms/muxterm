import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import type { MuxUIVoiceBars } from './voice-bars.js';
import './voice-bars.js';

const meta = {
  title:'Components/Voice bars',
  tags:['autodocs'],
  render:() => html`<div style="display:flex;align-items:center;gap:var(--ui-space-6);padding:var(--ui-space-6);width:max-content;border-radius:var(--ui-radius-lg);background:var(--ui-accent);color:var(--ui-on-accent)"><mux-ui-voice-bars aria-hidden="true"></mux-ui-voice-bars><span>Voice mode</span></div>`,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Resting: Story = {};
export const Speaking: Story = {
  play:async ({canvasElement}) => {
    const bars = canvasElement.querySelector<MuxUIVoiceBars>('mux-ui-voice-bars');
    if (!bars) return;
    await bars.updateComplete;
    bars.setLevels([.2,.8,.35,1,.5]);
  },
};
