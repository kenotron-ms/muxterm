import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './switch.js';

interface SwitchArgs { checked:boolean; disabled:boolean; label:string; description:string; layout:'inline'|'row' }
const meta = {
  title:'Components/Switch',
  tags:['autodocs'],
  args:{checked:false,disabled:false,label:'Worktree',description:'',layout:'inline' as const},
  render:(args:SwitchArgs) => html`<div style=${args.layout === 'row' ? 'width:min(100%,360px)' : ''}>
    <mux-ui-switch .checked=${args.checked} .disabled=${args.disabled}
      .label=${args.label} .description=${args.description} .layout=${args.layout}></mux-ui-switch>
  </div>`,
} satisfies Meta<SwitchArgs>;
export default meta;
type Story = StoryObj<SwitchArgs>;
export const Off: Story = {};
export const On: Story = { args:{checked:true} };
export const Disabled: Story = { args:{disabled:true} };
export const DescribedRow: Story = { args:{label:'Use worktree',description:'Create a separate worktree for this chat',layout:'row'} };
export const PhoneRow: Story = { args:{label:'Use worktree',description:'Create a separate worktree for this chat',layout:'row'}, globals:{viewport:{value:'phone390',isRotated:false}} };
