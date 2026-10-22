import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './listbox-option.js';

interface OptionArgs { label:string; description:string; selected:boolean; active:boolean; showCheck:boolean; layout:'stacked'|'inline' }
const meta = {
  title:'Components/Listbox Option', tags:['autodocs'],
  args:{label:'Atlas',description:'/home/demo/atlas',selected:true,active:false,showCheck:true,layout:'stacked' as const},
  render:(args:OptionArgs) => html`<div style="width:min(350px,100%);padding:var(--ui-space-5);background:var(--ui-surface-raised)">
    <mux-ui-listbox-option .label=${args.label} .description=${args.description} .selected=${args.selected} .active=${args.active} .showCheck=${args.showCheck} .layout=${args.layout}></mux-ui-listbox-option>
  </div>`,
} satisfies Meta<OptionArgs>;
export default meta;
type Story = StoryObj<OptionArgs>;
export const Selected: Story = {};
export const Active: Story = { args:{selected:false,active:true} };
export const Command: Story = { args:{label:'/goal',description:'View or set the goal',selected:true,active:true,showCheck:false,layout:'inline'} };
