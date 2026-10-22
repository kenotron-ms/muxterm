import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { DARK_TITLEBAR_CRAYONS, LIGHT_TITLEBAR_CRAYONS } from '../lib/instance-identity.js';
import type { ColorChoiceOption } from './color-picker.js';
import './color-picker.js';

const dark: ColorChoiceOption[] = DARK_TITLEBAR_CRAYONS.map(item => ({label:item.name,color:item.hex}));
const light: ColorChoiceOption[] = LIGHT_TITLEBAR_CRAYONS.map(item => ({label:item.name,color:item.hex}));
interface Args { value:string; options:ColorChoiceOption[]; fallbackColor:string }
const meta = {
  title:'Primitives/Color picker', tags:['autodocs'],
  args:{value:'#2b5889',options:dark,fallbackColor:'#16161e'},
  render:(args:Args) => html`<div style="width:min(440px,100%)"><mux-ui-color-picker .value=${args.value} .options=${args.options} .fallbackColor=${args.fallbackColor} inputLabel="Pick a custom title bar color"></mux-ui-color-picker></div>`,
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const DarkPresets: Story = {};
export const LightPresets: Story = { args:{value:'#aed9f2',options:light,fallbackColor:'#f6f8fa'}, globals:{palette:'github-light'} };
export const CustomColor: Story = { args:{value:'#403973'} };
export const Phone: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const DefaultColor: Story = { args:{value:''} };
