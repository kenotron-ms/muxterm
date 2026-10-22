import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './feedback.js';
import './button.js';
import type { FeedbackAppearance, FeedbackDensity, FeedbackKind, FeedbackLayout } from './feedback.js';

interface FeedbackArgs { kind: FeedbackKind; appearance: FeedbackAppearance; density: FeedbackDensity; layout: FeedbackLayout; message: string; align: 'start' | 'center' }
const meta = {
  title: 'Patterns/Feedback',
  tags: ['autodocs'],
  args: { kind:'empty', appearance:'panel', density:'regular', layout:'stacked', message:'No scheduled jobs yet. Use New job to choose a chat or start one.', align:'center' },
  argTypes: {
    kind: { control:'select', options:['empty','loading','info','success','warning','error'] },
    appearance: { control:'select', options:['plain','panel'] },
    density: { control:'select', options:['regular','compact'] },
    layout: { control:'select', options:['stacked','inline'] },
    align: { control:'select', options:['start','center'] },
  },
  render: (args: FeedbackArgs) => html`<div style="width:min(480px,100%)"><mux-ui-feedback .kind=${args.kind} .appearance=${args.appearance} .density=${args.density} .layout=${args.layout} .align=${args.align}>${args.message}</mux-ui-feedback></div>`,
} satisfies Meta<FeedbackArgs>;

export default meta;
type Story = StoryObj<FeedbackArgs>;
export const Empty: Story = {};
export const Loading: Story = { args: { kind:'loading', message:'Searching for skills…', align:'start' } };
export const Error: Story = { args: { kind:'error', message:'The connection could not be loaded.', align:'start' } };
export const Success: Story = { args: { kind:'success', message:'Skill installed for new chats.', align:'start' } };
export const Warning: Story = { args: { kind:'warning', message:'The last turn may have changed files. Review before continuing.', align:'start' } };
export const CompactLoading: Story = { args:{kind:'loading',appearance:'plain',density:'compact',message:'Loading models…',align:'start'} };
export const CompactError: Story = { args:{kind:'error',appearance:'plain',density:'compact',message:'Could not load model controls.',align:'start'} };
export const WithAction: Story = { render: () => html`<div style="width:min(480px,100%)"><mux-ui-feedback kind="empty" appearance="panel">No scheduled jobs yet.<mux-ui-button slot="action" variant="primary">New job</mux-ui-button></mux-ui-feedback></div>` };
export const InlineShellError: Story = { render:() => html`<div style="width:min(520px,100%);box-shadow:var(--ui-shadow-menu)"><mux-ui-feedback kind="error" appearance="panel" density="compact" layout="inline">The pane could not be closed. It remains open.<mux-ui-button slot="action" size="small" accessible-label="Dismiss close error">Dismiss</mux-ui-button></mux-ui-feedback></div>` };
export const PhoneInlineShellError: Story = { globals:{viewport:{value:'phone390',isRotated:false}}, render:() => html`<div style="width:min(366px,100%);box-shadow:var(--ui-shadow-menu)"><mux-ui-feedback kind="error" appearance="panel" density="compact" layout="inline">The pane could not be closed. It remains open.<mux-ui-button slot="action" size="small" accessible-label="Dismiss close error">Dismiss</mux-ui-button></mux-ui-feedback></div>` };
export const LongInlineShellError: Story = { render:() => html`<div style="width:min(520px,100%);box-shadow:var(--ui-shadow-menu)"><mux-ui-feedback kind="error" appearance="panel" density="compact" layout="inline">The session could not start. Your prompt: “Review the new workspace status and summarize any pending changes.”<mux-ui-button slot="action" size="small" accessible-label="Dismiss session start error">Dismiss</mux-ui-button></mux-ui-feedback></div>` };
