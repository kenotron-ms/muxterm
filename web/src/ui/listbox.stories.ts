import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './listbox.js';
import './listbox-option.js';

interface ListboxArgs { presentation:'popover'|'suggestions'; active:number }
const meta = {
  title:'Components/Listbox', tags:['autodocs'],
  args:{presentation:'popover' as const,active:0},
  render:(args:ListboxArgs) => html`<div style="min-height:400px;padding:var(--ui-space-7);background:var(--ui-surface-base)">
    <div style="position:relative;width:min(350px,100%);margin-top:${args.presentation === 'suggestions' ? 'calc(var(--ui-space-16) * 2)' : '0'}">
    <button style="min-height:var(--ui-control-md);padding:var(--ui-space-4);border:1px solid var(--ui-border);border-radius:var(--ui-radius-md);background:var(--ui-surface-raised);color:var(--ui-text)">Project · Atlas</button>
    <mux-ui-listbox label="Projects" .presentation=${args.presentation} style="--ui-listbox-width:var(--ui-picker-trigger-width)">
      <mux-ui-listbox-option label="Ungrouped" description="Choose a folder for this chat" ?active=${args.active === 0} show-check></mux-ui-listbox-option>
      <mux-ui-listbox-option label="Atlas" description="/home/demo/atlas" selected show-check ?active=${args.active === 1}></mux-ui-listbox-option>
      <div role="separator"></div>
      <mux-ui-listbox-option label="New project" description="Choose its primary folder" ?active=${args.active === 2}></mux-ui-listbox-option>
    </mux-ui-listbox></div>
  </div>`,
} satisfies Meta<ListboxArgs>;
export default meta;
type Story = StoryObj<ListboxArgs>;
export const SelectedProject: Story = { args:{active:1} };
export const ActiveDifferentFromSelected: Story = { args:{active:2} };
export const PhoneSheet: Story = { args:{active:1},globals:{viewport:{value:'phone390',isRotated:false}} };
export const Suggestions: Story = { args:{presentation:'suggestions',active:0} };
export const LightSelectedProject: Story = { args:{active:1},globals:{palette:'github-light'} };
