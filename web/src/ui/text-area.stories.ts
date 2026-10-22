import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './text-area.js';

interface AreaArgs { label:string; description:string; error:string; value:string; placeholder:string; disabled:boolean; required:boolean }
const meta = {
  title:'Foundations/Forms/Text area', tags:['autodocs'],
  args:{ label:'Standing instructions', description:'These instructions apply to future runs.', error:'', value:'', placeholder:'Describe what this job should do', disabled:false, required:false },
  render:(args:AreaArgs)=>html`<div style="width:min(460px,100%)"><mux-ui-text-area .label=${args.label} .description=${args.description} .error=${args.error} .value=${args.value} .placeholder=${args.placeholder} ?disabled=${args.disabled} ?required=${args.required}></mux-ui-text-area></div>`,
} satisfies Meta<AreaArgs>;
export default meta;
type Story = StoryObj<AreaArgs>;
export const Default:Story = {};
export const Filled:Story = { args:{ value:'Review open pull requests and summarize the risks for the team.' } };
export const Error:Story = { args:{ error:'Add standing instructions before scheduling this job.', required:true } };
export const Disabled:Story = { args:{ value:'This job is managed elsewhere.', disabled:true } };
