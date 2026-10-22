import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './reconnect-overlay.js';

interface ReconnectArgs {
  phase: 'retrying' | 'waiting' | 'offline';
  fatal: boolean;
  message: string;
  detail: string;
}
const meta = {
  title: 'Patterns/Reconnect overlay',
  tags: ['autodocs'],
  args: { phase:'retrying', fatal:false, message:'', detail:'' },
  argTypes: { phase: { control:'select', options:['retrying','waiting','offline'] } },
  render: (args: ReconnectArgs) => html`<mux-reconnect-overlay
    .phase=${args.phase} .nextAttemptAt=${Date.now() + 8000}
    .fatal=${args.fatal} .message=${args.message} .detail=${args.detail}
  ></mux-reconnect-overlay>`,
} satisfies Meta<ReconnectArgs>;

export default meta;
type Story = StoryObj<ReconnectArgs>;
export const Retrying: Story = {};
export const Waiting: Story = { args: { phase:'waiting' } };
export const Offline: Story = { args: { phase:'offline' } };
export const Fatal: Story = { args: { fatal:true, phase:'offline', message:'Cannot restore this connection', detail:'The server reported a fatal session error.\nCheck the connection and reopen the workspace.' } };
