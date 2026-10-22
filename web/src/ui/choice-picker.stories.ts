import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './choice-picker.js';
import './choice-item.js';
import './choice-section.js';

interface PickerArgs { summary:string; placement:'below'|'above'; appearance:'outlined'|'plain'; panelAlign:'left'|'right'; open:boolean }
const meta = {
  title:'Components/Choice Picker',
  tags:['autodocs'],
  args:{summary:'GPT-6-Sol',placement:'below',appearance:'outlined',panelAlign:'left',open:false},
  render:(args:PickerArgs) => html`<div style="min-height:440px;display:flex;align-items:${args.placement === 'above' ? 'end' : 'start'};justify-content:${args.panelAlign === 'right' ? 'end' : 'start'};padding:32px">
    <mux-ui-choice-picker label="Provider, model and thinking" .summary=${args.summary}
      .placement=${args.placement} .appearance=${args.appearance} .panelAlign=${args.panelAlign} .open=${args.open}>
      <mux-ui-choice-section heading="Model">
        <mux-ui-choice-item label="GPT-6-Sol" description="General purpose model" selected></mux-ui-choice-item>
        <mux-ui-choice-item label="GPT-6-Astra" description="Complex reasoning"></mux-ui-choice-item>
      </mux-ui-choice-section>
    </mux-ui-choice-picker>
  </div>`,
} satisfies Meta<PickerArgs>;
export default meta;
type Story = StoryObj<PickerArgs>;
export const Closed: Story = {};
export const OpenBelow: Story = { args:{open:true} };
export const OpenAbove: Story = { args:{open:true,placement:'above',appearance:'plain',panelAlign:'right'} };
export const PhoneSheet: Story = { args:{open:true}, globals:{viewport:{value:'phone390',isRotated:false}} };
