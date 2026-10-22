import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './status-badge.js';
import type { StatusBadgeAppearance, StatusTone } from './status-badge.js';

interface BadgeArgs { tone: StatusTone; appearance: StatusBadgeAppearance; label: string; dot: boolean }
const meta = {
  title: 'Foundations/Status badge',
  tags: ['autodocs'],
  args: { tone:'neutral', appearance:'pill', label:'Setup required', dot:false },
  argTypes: { tone: { control:'select', options:['neutral','success','warning','info','danger'] }, appearance:{control:'select',options:['pill','plain']} },
  render: (args: BadgeArgs) => html`<mux-ui-status-badge .tone=${args.tone} .appearance=${args.appearance} ?dot=${args.dot}>${args.label}</mux-ui-status-badge>`,
} satisfies Meta<BadgeArgs>;

export default meta;
type Story = StoryObj<BadgeArgs>;
export const Default: Story = {};
export const Ready: Story = { args: { tone:'success', label:'Ready', dot:true } };
export const NeedsAttention: Story = { args: { tone:'warning', label:'Needs attention', dot:true } };
export const Running: Story = { args: { tone:'info', label:'Running', dot:true } };
export const Failed: Story = { args: { tone:'danger', label:'Failed', dot:true } };
export const AllStates: Story = { render: () => html`<div style="display:flex;flex-wrap:wrap;gap:var(--ui-space-5)"><mux-ui-status-badge dot tone="success">Active</mux-ui-status-badge><mux-ui-status-badge dot tone="info">Running</mux-ui-status-badge><mux-ui-status-badge dot tone="warning">Needs attention</mux-ui-status-badge><mux-ui-status-badge dot tone="danger">Failed</mux-ui-status-badge><mux-ui-status-badge dot>Paused</mux-ui-status-badge></div>` };
export const InlineStates: Story = { render:() => html`<div style="display:flex;flex-wrap:wrap;align-items:center;gap:var(--ui-space-6);font:600 var(--ui-text-md) var(--ui-font-sans)"><mux-ui-status-badge appearance="plain" dot tone="info">Working</mux-ui-status-badge><mux-ui-status-badge appearance="plain" dot tone="success">Ready</mux-ui-status-badge><mux-ui-status-badge appearance="plain" dot tone="danger">Failed</mux-ui-status-badge><mux-ui-status-badge appearance="plain" dot>Unknown</mux-ui-status-badge></div>` };
export const PhoneInlineStates: Story = { globals:{viewport:{value:'phone390',isRotated:false}}, render:InlineStates.render };
export const LightInlineStates: Story = { globals:{palette:'github-light'}, render:InlineStates.render };
export const WrappedError: Story = { render:() => html`<div style="width:var(--ui-attachment-card-width)"><mux-ui-status-badge appearance="plain" tone="danger" dot wrap>The file could not be uploaded. Try attaching it again.</mux-ui-status-badge></div>` };
