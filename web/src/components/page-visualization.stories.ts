import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './mux-blocknote-page.js';

type Args = { chartType: 'bar' | 'line'; palette: 'paper' | 'ink' };

const points = [
  { label: 'Mon', value: 18, detail: 'Requests handled on Monday' },
  { label: 'Tue', value: 27, detail: 'Requests handled on Tuesday' },
  { label: 'Wed', value: 21, detail: 'Requests handled on Wednesday' },
  { label: 'Thu', value: 34, detail: 'Requests handled on Thursday' },
];

const ink = '--ui-document-surface:#1b2230;--ui-document-text:#e6edf7;--ui-document-muted:#a8b4c7;--ui-document-accent:#8fb7ff;--ui-document-border:#485469;';

const meta = {
  title: 'Composites/Page visualization',
  tags: ['autodocs'],
  args: { chartType: 'bar', palette: 'paper' },
  render: (args: Args) => html`
    <div style=${`${args.palette === 'ink' ? ink : ''}box-sizing:border-box;min-height:440px;max-width:760px;padding:var(--ui-space-8);background:var(--ui-document-surface);color:var(--ui-document-text)`}>
      <mux-blocknote-page
        .content=${[{ type: 'visualization', props: { title: 'Requests handled', caption: 'Daily totals from the current project', chartType: args.chartType, points: JSON.stringify(points) } }]}
        .pageId=${`story-${args.chartType}-${args.palette}`}
      ></mux-blocknote-page>
    </div>`,
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<Args>;

export const Bar: Story = {};
export const Line: Story = { args: { chartType: 'line' } };
export const DarkDocument: Story = { args: { palette: 'ink' } };
export const Phone: Story = { globals: { viewport: { value: 'phone390', isRotated: false } } };
