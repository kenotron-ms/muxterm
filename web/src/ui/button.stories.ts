import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { ArrowUp, Paperclip, Trash2 } from 'lucide';
import { icon } from '../lib/icons.js';
import './button.js';
import type { ButtonSize, ButtonVariant } from './button.js';

interface ButtonArgs {
  label: string;
  variant: ButtonVariant;
  size: ButtonSize;
  disabled: boolean;
  busy: boolean;
}

const meta = {
  title: 'Foundations/Actions/Button',
  tags: ['autodocs'],
  args: { label: 'Open workspace', variant: 'secondary', size: 'medium', disabled: false, busy: false },
  argTypes: {
    variant: { control: 'select', options: ['primary', 'secondary', 'quiet', 'danger'] },
    size: { control: 'select', options: ['small', 'medium', 'large'] },
  },
  render: (args: ButtonArgs) => html`<mux-ui-button .variant=${args.variant} .size=${args.size}
    ?disabled=${args.disabled} ?busy=${args.busy}>${args.label}</mux-ui-button>`,
} satisfies Meta<ButtonArgs>;

export default meta;
type Story = StoryObj<ButtonArgs>;

export const Secondary: Story = {};
export const Primary: Story = { args: { variant: 'primary', label: 'Create workspace' } };
export const Quiet: Story = { args: { variant: 'quiet', label: 'Cancel' } };
export const Danger: Story = { args: { variant: 'danger', label: 'Close pane' } };
export const Busy: Story = { args: { variant: 'primary', label: 'Saving changes', busy: true } };
export const Disabled: Story = { args: { label: 'Unavailable', disabled: true } };
export const Sizes: Story = {
  render: () => html`<div style="display:flex;align-items:center;gap:16px">
    <mux-ui-button size="small">Small</mux-ui-button>
    <mux-ui-button size="medium">Medium</mux-ui-button>
    <mux-ui-button size="large">Large</mux-ui-button>
  </div>`,
};
export const IconOnly: Story = {
  render: () => html`<div style="display:flex;align-items:center;gap:var(--ui-space-5)">
    <mux-ui-button icon-only size="small" variant="quiet" accessible-label="Attach file">${icon(Paperclip,{size:16})}</mux-ui-button>
    <mux-ui-button icon-only variant="primary" accessible-label="Send message">${icon(ArrowUp,{size:18})}</mux-ui-button>
    <mux-ui-button icon-only size="large" variant="danger" accessible-label="Delete item">${icon(Trash2,{size:20})}</mux-ui-button>
    <mux-ui-button icon-only variant="primary" accessible-label="Send message" disabled>${icon(ArrowUp,{size:18})}</mux-ui-button>
  </div>`,
};
