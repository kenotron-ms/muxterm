import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './choice-list.js';
import './choice-item.js';
import './choice-picker.js';
import './choice-section.js';

const meta = {
  title:'Components/Choice List',
  tags:['autodocs'],
  parameters:{layout:'fullscreen'},
  render:() => html`<div style="min-height:440px;padding:32px"><mux-ui-choice-picker label="Model" summary="Model 1" open>
    <mux-ui-choice-section heading="Model"><mux-ui-choice-list>
      ${Array.from({length:12},(_,index) => html`<mux-ui-choice-item label=${`Model ${index + 1}`} description=${`model-${index + 1}`} ?selected=${index === 0}></mux-ui-choice-item>`)}
    </mux-ui-choice-list></mux-ui-choice-section>
  </mux-ui-choice-picker></div>`,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;
export const ScrollingModels: Story = {};
export const PhoneScrollingModels: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
