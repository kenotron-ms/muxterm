import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './feedback.js';
import './button.js';
import type { FeedbackAppearance, FeedbackKind } from './feedback.js';

interface FeedbackArgs { kind: FeedbackKind; appearance: FeedbackAppearance; message: string; align: 'start' | 'center' }
const meta = {
  title: 'Patterns/Feedback',
  tags: ['autodocs'],
  args: { kind:'empty', appearance:'panel', message:'No scheduled jobs yet. Use New job to choose a chat or start one.', align:'center' },
  argTypes: {
    kind: { control:'select', options:['empty','loading','info','success','warning','error'] },
    appearance: { control:'select', options:['plain','panel'] },
    align: { control:'select', options:['start','center'] },
  },
  render: (args: FeedbackArgs) => html`<div style="width:min(480px,100%)"><mux-ui-feedback .kind=${args.kind} .appearance=${args.appearance} .align=${args.align}>${args.message}</mux-ui-feedback></div>`,
} satisfies Meta<FeedbackArgs>;

export default meta;
type Story = StoryObj<FeedbackArgs>;
export const Empty: Story = {};
export const Loading: Story = { args: { kind:'loading', message:'Searching for skills…', align:'start' } };
export const Error: Story = { args: { kind:'error', message:'The connection could not be loaded.', align:'start' } };
export const Success: Story = { args: { kind:'success', message:'Skill installed for new chats.', align:'start' } };
export const Warning: Story = { args: { kind:'warning', message:'The last turn may have changed files. Review before continuing.', align:'start' } };
export const WithAction: Story = { render: () => html`<div style="width:min(480px,100%)"><mux-ui-feedback kind="empty" appearance="panel">No scheduled jobs yet.<mux-ui-button slot="action" variant="primary">New job</mux-ui-button></mux-ui-feedback></div>` };
