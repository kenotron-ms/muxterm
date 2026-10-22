import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './select.js';
import type { SelectOption } from './select.js';

interface SelectArgs { label:string; description:string; error:string; value:string; disabled:boolean; required:boolean }
const options:SelectOption[] = [
  {value:'',label:'Choose a status'}, {value:'active',label:'Active'},
  {value:'paused',label:'Paused'}, {value:'attention',label:'Needs attention'},
];
const meta = {
  title:'Foundations/Forms/Select', tags:['autodocs'],
  args:{label:'Status',description:'Filter scheduled jobs by status.',error:'',value:'',disabled:false,required:false},
  render:(args:SelectArgs)=>html`<div style="width:min(320px,100%)"><mux-ui-select .label=${args.label} .description=${args.description} .error=${args.error} .value=${args.value} .options=${options} ?disabled=${args.disabled} ?required=${args.required}></mux-ui-select></div>`,
} satisfies Meta<SelectArgs>;
export default meta;
type Story = StoryObj<SelectArgs>;
export const Default:Story = {};
export const Selected:Story = {args:{value:'active'}};
export const Compact:Story = {render:()=>html`<div style="width:120px"><mux-ui-select size="small" aria-label="Sort files" .options=${[{value:'name',label:'Name'},{value:'recent',label:'Recent'},{value:'size',label:'Size'}]} value="name"></mux-ui-select></div>`};
export const Error:Story = {args:{error:'Choose a status.',required:true}};
export const Disabled:Story = {args:{value:'paused',disabled:true}};
