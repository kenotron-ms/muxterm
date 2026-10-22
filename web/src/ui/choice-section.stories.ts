import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './choice-section.js';
import './choice-item.js';

interface SectionArgs { heading:string; description:string; separated:boolean }
const meta = {
  title:'Components/Choice Section',
  tags:['autodocs'],
  args:{heading:'Model',description:'',separated:false},
  render:(args:SectionArgs) => html`<div style="width:min(100%,360px);padding:var(--ui-space-4);background:var(--ui-surface-raised);border:1px solid var(--ui-border);border-radius:var(--ui-radius-xl)">
    <mux-ui-choice-section .heading=${args.heading} .description=${args.description} .separated=${args.separated}>
      <mux-ui-choice-item label="GPT-6-Sol" description="General purpose model" selected></mux-ui-choice-item>
      <mux-ui-choice-item label="GPT-6-Astra" description="Complex reasoning"></mux-ui-choice-item>
    </mux-ui-choice-section>
  </div>`,
} satisfies Meta<SectionArgs>;
export default meta;
type Story = StoryObj<SectionArgs>;
export const Choices: Story = {};
export const WithDescription: Story = { args:{heading:'Provider',description:'OpenAI · managed by Codex'} };
export const Separated: Story = { args:{separated:true} };
export const Phone: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
