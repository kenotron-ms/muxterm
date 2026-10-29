import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import type { MuxMeetings } from './mux-meetings.js';
import { drawRecordingVideo } from './mux-meetings.js';

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

export const TranscriptionChoices: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector<MuxMeetings>('mux-meetings')?.showSample('transcription');
  },
};

export const RecordedCallFrame: Story = {
  render: () => html`<div style="min-height:100vh;display:grid;place-items:center;background:#101722;padding:24px"><canvas width="1280" height="720" style="width:min(100%,1280px);height:auto"></canvas></div>`,
  play: ({ canvasElement }) => {
    const frame=canvasElement.querySelector('canvas');
    const context=frame?.getContext('2d');
    if (!context) return;
    context.fillStyle='#161c28';
    context.fillRect(0,0,1280,720);
    for (const [index,color] of ['#426178','#82654b'].entries()) {
      const source=document.createElement('canvas');
      source.width=640;source.height=360;
      const sourceContext=source.getContext('2d');
      if (!sourceContext) continue;
      sourceContext.fillStyle=color;sourceContext.fillRect(0,0,640,360);
      sourceContext.fillStyle='#e8c6a8';sourceContext.beginPath();sourceContext.arc(320,165,78,0,Math.PI*2);sourceContext.fill();
      sourceContext.fillStyle='#263345';sourceContext.fillRect(208,250,224,110);
      drawRecordingVideo(context,source,640,360,index*640,0,640,720,'cover');
    }
  },
};
