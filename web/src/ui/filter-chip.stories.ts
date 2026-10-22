import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './filter-chip.js';

interface ChipArgs { label:string; count:number; pressed:boolean; disabled:boolean }
const meta = {
  title:'Foundations/Actions/Filter chip',
  tags:['autodocs'],
  args:{label:'Needs attention',count:3,pressed:false,disabled:false},
  render:(args:ChipArgs)=>html`<mux-ui-filter-chip .count=${args.count} ?pressed=${args.pressed} ?disabled=${args.disabled}>${args.label}</mux-ui-filter-chip>`,
} satisfies Meta<ChipArgs>;
export default meta;
type Story = StoryObj<ChipArgs>;

export const Default:Story = {};
export const Selected:Story = {args:{pressed:true}};
export const ZeroCount:Story = {args:{label:'Running',count:0}};
export const Disabled:Story = {args:{disabled:true}};
export const Group:Story = {render:()=>html`<div role="group" aria-label="Filter lanes" style="display:flex;flex-wrap:wrap;gap:var(--ui-space-3)"><mux-ui-filter-chip pressed count="8">All</mux-ui-filter-chip><mux-ui-filter-chip count="2">Needs attention</mux-ui-filter-chip><mux-ui-filter-chip count="3">Running</mux-ui-filter-chip><mux-ui-filter-chip count="3">Done</mux-ui-filter-chip></div>`};
