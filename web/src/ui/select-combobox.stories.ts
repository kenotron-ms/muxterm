import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { Folder, Plus } from 'lucide';
import { icon } from '../lib/icons.js';
import type { MuxUISelectCombobox, SelectComboboxOption } from './select-combobox.js';
import './select-combobox.js';

const options: SelectComboboxOption[] = [
  {value:'ungrouped',label:'Ungrouped',description:'Choose a folder for this chat',icon:icon(Folder,{size:16})},
  {value:'atlas',label:'Atlas',description:'/home/demo/atlas',icon:icon(Folder,{size:16})},
  {value:'research',label:'Research',description:'/home/demo/research',icon:icon(Folder,{size:16})},
  {value:'new',label:'New project',description:'Choose its primary folder',icon:icon(Plus,{size:16}),separatorBefore:true},
];
interface ComboboxArgs { value:string; options:SelectComboboxOption[]; disabled:boolean; appearance:'tinted'|'outlined' }
const meta = {
  title:'Components/Select Combobox', tags:['autodocs'],
  args:{value:'atlas',options,disabled:false,appearance:'tinted' as const},
  render:(args:ComboboxArgs) => html`<div style="box-sizing:border-box;min-height:430px;padding:var(--ui-space-8);background:var(--ui-surface-base);color:var(--ui-text)"><mux-ui-select-combobox label="Project" .value=${args.value} .options=${args.options} .disabled=${args.disabled} .appearance=${args.appearance} @change=${(event:CustomEvent<{value:string}>) => { (event.target as MuxUISelectCombobox).value = event.detail.value; }}></mux-ui-select-combobox></div>`,
} satisfies Meta<ComboboxArgs>;
export default meta;
type Story = StoryObj<ComboboxArgs>;
export const Selected: Story = {};
export const Phone: Story = {globals:{viewport:{value:'phone390',isRotated:false}}};
export const Light: Story = {globals:{palette:'github-light'}};
export const Disabled: Story = {args:{disabled:true}};
export const LongValue: Story = {args:{value:'research',options:[...options.slice(0,2),{value:'research',label:'Research and development of the new terminal interface',description:'/home/demo/research',icon:icon(Folder,{size:16})},options[3]]}};
