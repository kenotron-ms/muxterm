import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './confirmation.js';

interface ConfirmationArgs {
  heading: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
}

const meta = {
  title: 'Components/Confirmation',
  tags: ['autodocs'],
  args: {
    heading: 'Disconnect Microsoft?',
    description: 'This removes the saved account authorization. New chats will lose access to Microsoft mail, calendar and files.',
    confirmLabel: 'Disconnect account',
    busy: false,
  },
  render: (args:ConfirmationArgs) => html`<div style="min-height:100vh;background:var(--ui-surface-base)">
    <mux-ui-confirmation open .busy=${args.busy} .heading=${args.heading} .description=${args.description}
      .confirmLabel=${args.confirmLabel}
      @confirmation-confirm=${(event:Event) => { const status=(event.currentTarget as HTMLElement).nextElementSibling; if(status) status.textContent='Confirmation requested.'; }}
      @confirmation-cancel=${(event:Event) => { const status=(event.currentTarget as HTMLElement).nextElementSibling; if(status) status.textContent='Cancelled.'; }}
    ></mux-ui-confirmation>
    <div role="status" style="padding:var(--ui-space-6);color:var(--ui-text-muted)">Choose an action.</div>
  </div>`,
} satisfies Meta<ConfirmationArgs>;

export default meta;
type Story = StoryObj<ConfirmationArgs>;
export const Desktop:Story = {};
export const Phone:Story = {globals:{viewport:{value:'phone390',isRotated:false}}};
export const Busy:Story = {args:{busy:true}};
export const LightPalette:Story = {globals:{palette:'github-light'}};
