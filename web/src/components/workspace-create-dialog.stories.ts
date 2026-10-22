import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './workspace-create-dialog.js';

interface WorkspaceCreateArgs { busy:boolean }
const meta = {
  title:'Composites/Workspace create dialog', tags:['autodocs'],
  args:{busy:false},
  render:(args:WorkspaceCreateArgs) => html`<div style="min-height:600px;background:var(--ui-surface-base);color:var(--ui-text)"><mux-workspace-create-dialog open .busy=${args.busy}></mux-workspace-create-dialog></div>`,
} satisfies Meta<WorkspaceCreateArgs>;
export default meta;
type Story = StoryObj<WorkspaceCreateArgs>;
export const Desktop: Story = {};
export const Phone: Story = {globals:{viewport:{value:'phone390',isRotated:false}}};
export const Busy: Story = {args:{busy:true}};
export const Light: Story = {globals:{palette:'github-light'}};
