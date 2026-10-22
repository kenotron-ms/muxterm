import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { ArrowUp, Ellipsis, NotebookPen, Paperclip, Trash2 } from 'lucide';
import { icon } from '../lib/icons.js';
import './button.js';
import type { ButtonSize, ButtonVariant, MuxUIButton } from './button.js';

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
  render: () => html`<div style="display:flex;align-items:center;gap:var(--ui-space-6)">
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
export const PhoneIconOnly: Story = {
  globals:{viewport:{value:'phone390',isRotated:false}},
  render:IconOnly.render,
};
export const PhoneSmall: Story = {
  globals:{viewport:{value:'phone390',isRotated:false}},
  args:{size:'small',label:'Open file'},
};
export const MenuTrigger: Story = {
  render:() => html`<mux-ui-button icon-only size="small" variant="quiet" tone="muted" accessible-label="Project options" tooltip="Project options" haspopup="menu" @click=${(event:Event) => { const button = event.currentTarget as MuxUIButton; button.expanded = !button.expanded; }}>${icon(Ellipsis,{size:16})}</mux-ui-button>`,
};
export const Disclosure: Story = {
  render:() => html`<mux-ui-button variant="quiet" expandable @click=${(event:Event) => { const button = event.currentTarget as MuxUIButton; button.expanded = !button.expanded; }}>Open navigation</mux-ui-button>`,
};
export const ControlledDisclosure: Story = {
  render:() => html`<div><mux-ui-button variant="quiet" expandable .controls=${'story-disclosure-panel'} accessible-label="Show details" @click=${(event:Event) => { const button = event.currentTarget as MuxUIButton; button.expanded = !button.expanded; }}>Show details</mux-ui-button><div id="story-disclosure-panel" role="region" aria-label="Details">Panel content</div></div>`,
};
export const ToggleIcon: Story = {
  render:() => html`<mux-ui-button icon-only size="small" variant="quiet" tone="muted" toggle accessible-label="Show file browser" tooltip="Show file browser" @click=${(event:Event) => { const button = event.currentTarget as MuxUIButton; button.pressed = !button.pressed; }}>${icon(Paperclip,{size:16})}</mux-ui-button>`,
};
export const DocumentActions: Story = {
  render:() => html`<div style="display:flex;align-items:center;gap:var(--ui-space-4);padding:var(--ui-space-6);background:var(--ui-document-surface)">
    <mux-ui-button appearance="document" icon-only size="small" variant="quiet" tone="muted" toggle pressed accessible-label="Hide pages list">${icon(NotebookPen,{size:16})}</mux-ui-button>
    <mux-ui-button appearance="document" size="small" variant="secondary">New page</mux-ui-button>
    <mux-ui-button appearance="document" icon-only size="small" variant="quiet" tone="danger" accessible-label="Delete page">${icon(Trash2,{size:16})}</mux-ui-button>
  </div>`,
};
