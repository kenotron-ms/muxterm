import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './range-field.js';

interface RangeArgs {
  label:string; accessibleLabel:string; valueLabels:string[]; unit:string; minLabel:string; maxLabel:string;
  min:number; max:number; value:number; disabled:boolean; layout:'stacked'|'inline';
}
const meta = {
  title:'Components/Range Field',
  tags:['autodocs'],
  args:{label:'Thinking',accessibleLabel:'Thinking effort',valueLabels:['low','medium','high','xhigh','ultra'],unit:'',minLabel:'low',maxLabel:'ultra',min:0,max:4,value:2,disabled:false,layout:'stacked'},
  render:(args:RangeArgs) => html`<div style="width:min(100%,360px);background:var(--ui-surface-raised);border:1px solid var(--ui-border);border-radius:var(--ui-radius-lg)">
    <mux-ui-range-field .label=${args.label} .accessibleLabel=${args.accessibleLabel}
      .valueLabels=${args.valueLabels} .unit=${args.unit} .minLabel=${args.minLabel} .maxLabel=${args.maxLabel}
      .min=${args.min} .max=${args.max} .value=${args.value}
      .disabled=${args.disabled} .layout=${args.layout}></mux-ui-range-field>
  </div>`,
} satisfies Meta<RangeArgs>;
export default meta;
type Story = StoryObj<RangeArgs>;
export const Thinking: Story = {};
export const Disabled: Story = { args:{disabled:true} };
export const FontSize: Story = { args:{label:'Size',accessibleLabel:'Terminal font size',valueLabels:[],unit:' px',minLabel:'',maxLabel:'',min:8,max:24,value:14,layout:'inline'} };
export const PhoneThinking: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
