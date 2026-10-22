import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { PALETTES } from '../lib/theme.js';
import './theme-choice.js';

interface Args { selected:string; disabled:boolean }
const meta = {
  title:'Primitives/Theme choice', tags:['autodocs'],
  args:{selected:'tokyo-night',disabled:false},
  render:(args:Args) => html`<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--ui-space-5);width:min(380px,100%)">
    <mux-ui-theme-choice label="Tokyo Night" .preview=${PALETTES['tokyo-night']} ?selected=${args.selected === 'tokyo-night'} ?disabled=${args.disabled}></mux-ui-theme-choice>
    <mux-ui-theme-choice label="GitHub" .preview=${PALETTES['github-light']} ?selected=${args.selected === 'github-light'} ?disabled=${args.disabled}></mux-ui-theme-choice>
  </div>`,
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const DarkSelected: Story = {};
export const LightSelected: Story = { args:{selected:'github-light'}, globals:{palette:'github-light'} };
export const Phone: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const Disabled: Story = { args:{disabled:true} };
export const KeyboardFocus: Story = { play:async ({canvasElement}) => { canvasElement.querySelector<HTMLElement>('mux-ui-theme-choice[label="GitHub"]')?.focus(); } };
export const CustomBackdrop: Story = { render:() => html`<div style="width:180px"><mux-ui-theme-choice label="Custom dusk" selected .preview=${{background:'#21213b',foreground:'#f0e9ff',blue:'#a9bfff',green:'#9fd9bd',cursor:'#f0e9ff',backgroundImage:'linear-gradient(135deg,rgba(95,52,130,.65),transparent 70%)'}}></mux-ui-theme-choice></div>` };
