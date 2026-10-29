import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import type { MuxMeetings } from './mux-meetings.js';
import './mux-meetings.js';

const meta = {
  title: 'Components/Meetings',
  parameters: { layout: 'fullscreen', fullBleed: true },
  render: () => html`<div style="height:100vh"><mux-meetings sessionId="storybook-meetings"></mux-meetings></div>`,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Library: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector<MuxMeetings>('mux-meetings')?.showSample('library');
  },
};

export const HostingRequired: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector<MuxMeetings>('mux-meetings')?.showSample('hosting-required');
  },
};
