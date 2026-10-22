import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import type { RadioOption } from './radio-group.js';
import './radio-group.js';

const bell: RadioOption[] = [
  {value:'visual',label:'Visual',description:'Flash the pane tab'},
  {value:'audible',label:'Audible',description:'Play the system bell sound'},
  {value:'off',label:'Off',description:'Silence all bell events'},
];

interface Args { value:string; options:RadioOption[]; disabled:boolean }
const meta = {
  title:'Primitives/Radio group', tags:['autodocs'],
  args:{value:'visual',options:bell,disabled:false},
  render:(args:Args) => html`<div style="width:min(440px,100%)"><mux-ui-radio-group label="Bell" name="bell" .value=${args.value} .options=${args.options} ?disabled=${args.disabled}></mux-ui-radio-group></div>`,
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const DescribedChoices: Story = {};
export const Phone: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const Light: Story = { globals:{palette:'github-light'} };
export const Disabled: Story = { args:{disabled:true} };
export const FontChoices: Story = { args:{value:'Fira Code',options:[
  {value:'JetBrains Mono',label:'JetBrains Mono',fontFamily:'JetBrains Mono'},
  {value:'Fira Code',label:'Fira Code',fontFamily:'Fira Code'},
  {value:'Cascadia Code',label:'Cascadia Code',fontFamily:'Cascadia Code'},
]} };
