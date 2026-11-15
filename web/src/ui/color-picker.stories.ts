import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import type { ColorChoiceOption } from './color-picker.js';
import './color-picker.js';

const dark: ColorChoiceOption[] = [{label:'Ocean',color:'#2b5889'},{label:'Clover',color:'#296144'},{label:'Grape',color:'#6b4290'}];
const light: ColorChoiceOption[] = [{label:'Sky',color:'#aed9f2'},{label:'Honeydew',color:'#c9e4a8'},{label:'Orchid',color:'#ddbbea'}];
interface Args { value:string; options:ColorChoiceOption[]; fallbackColor:string }
const meta = {
  title:'Primitives/Color picker', tags:['autodocs'],
  args:{value:'#2b5889',options:dark,fallbackColor:'#16161e'},
  render:(args:Args) => html`<div style="width:min(440px,100%)"><mux-ui-color-picker .value=${args.value} .options=${args.options} .fallbackColor=${args.fallbackColor} inputLabel="Pick a custom color"></mux-ui-color-picker></div>`,
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const DarkPresets: Story = {};
export const LightPresets: Story = { args:{value:'#aed9f2',options:light,fallbackColor:'#f6f8fa'}, globals:{palette:'github-light'} };
export const CustomColor: Story = { args:{value:'#403973'} };
export const Phone: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const DefaultColor: Story = { args:{value:''} };
