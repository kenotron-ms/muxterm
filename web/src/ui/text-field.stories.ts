import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './text-field.js';
import type { TextFieldType } from './text-field.js';

interface FieldArgs {
  label: string;
  description: string;
  error: string;
  placeholder: string;
  value: string;
  type: TextFieldType;
  disabled: boolean;
  required: boolean;
}

const meta = {
  title: 'Foundations/Forms/Text field',
  tags: ['autodocs'],
  args: { label:'Project name', description:'Shown in the workspace list.', error:'', placeholder:'Name this project', value:'', type:'text', disabled:false, required:false },
  argTypes: { type: { control:'select', options:['text','search','email','url','password'] } },
  render: (args: FieldArgs) => html`<div style="width:min(360px,100%)"><mux-ui-text-field
    .label=${args.label} .description=${args.description} .error=${args.error}
    .placeholder=${args.placeholder} .value=${args.value} .type=${args.type}
    ?disabled=${args.disabled} ?required=${args.required}></mux-ui-text-field></div>`,
} satisfies Meta<FieldArgs>;

export default meta;
type Story = StoryObj<FieldArgs>;
export const Default: Story = {};
export const Search: Story = { args: { label:'', description:'', type:'search', placeholder:'Search skills' }, render: (args) => html`<div style="width:320px"><mux-ui-text-field .type=${args.type} .placeholder=${args.placeholder} aria-label="Search skills"></mux-ui-text-field></div>` };
export const CompactSearch: Story = { render:() => html`<div style="width:240px"><mux-ui-text-field size="small" type="search" placeholder="Filter files…" aria-label="Filter visible files"></mux-ui-text-field></div>` };
export const Error: Story = { args: { error:'Enter a project name to continue.', required:true } };
export const Disabled: Story = { args: { label:'Repository', value:'Unavailable', disabled:true } };
export const ReadOnly: Story = { render:() => html`<div style="width:min(460px,100%)"><mux-ui-text-field label="Callback URL" value="https://muxterm.example.test/api/connections/remote/callback" readonly></mux-ui-text-field></div>` };
