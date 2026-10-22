import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './status-badge.js';
import type { StatusTone } from './status-badge.js';

interface BadgeArgs { tone: StatusTone; label: string; dot: boolean }
const meta = {
  title: 'Foundations/Status badge',
  tags: ['autodocs'],
  args: { tone:'neutral', label:'Setup required', dot:false },
  argTypes: { tone: { control:'select', options:['neutral','success','warning','info','danger'] } },
  render: (args: BadgeArgs) => html`<mux-ui-status-badge .tone=${args.tone} ?dot=${args.dot}>${args.label}</mux-ui-status-badge>`,
} satisfies Meta<BadgeArgs>;

export default meta;
type Story = StoryObj<BadgeArgs>;
export const Default: Story = {};
export const Ready: Story = { args: { tone:'success', label:'Ready', dot:true } };
export const NeedsAttention: Story = { args: { tone:'warning', label:'Needs attention', dot:true } };
export const Running: Story = { args: { tone:'info', label:'Running', dot:true } };
export const Failed: Story = { args: { tone:'danger', label:'Failed', dot:true } };
export const AllStates: Story = { render: () => html`<div style="display:flex;flex-wrap:wrap;gap:var(--ui-space-5)"><mux-ui-status-badge dot tone="success">Active</mux-ui-status-badge><mux-ui-status-badge dot tone="info">Running</mux-ui-status-badge><mux-ui-status-badge dot tone="warning">Needs attention</mux-ui-status-badge><mux-ui-status-badge dot tone="danger">Failed</mux-ui-status-badge><mux-ui-status-badge dot>Paused</mux-ui-status-badge></div>` };
