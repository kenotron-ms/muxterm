import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './choice-item.js';

interface ChoiceArgs { label:string; description:string; selected:boolean; disabled:boolean }
const meta = {
  title:'Components/Choice Item',
  tags:['autodocs'],
  args:{label:'GPT-6-Sol',description:'General purpose model',selected:false,disabled:false},
  render:(args:ChoiceArgs) => html`<div style="width:min(100%,360px)">
    <mux-ui-choice-item .label=${args.label} .description=${args.description}
      .selected=${args.selected} .disabled=${args.disabled}></mux-ui-choice-item>
  </div>`,
} satisfies Meta<ChoiceArgs>;
export default meta;
type Story = StoryObj<ChoiceArgs>;
export const Available: Story = {};
export const Selected: Story = { args:{selected:true} };
export const Disabled: Story = { args:{disabled:true} };
export const WithoutDescription: Story = { args:{label:'Harness default',description:''} };
export const PhoneSelected: Story = { args:{selected:true}, globals:{viewport:{value:'phone390',isRotated:false}} };
