import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { ChevronDown, ChevronRight, FileText, Folder, GitCompare, NotebookPen } from 'lucide';
import { icon } from '../lib/icons.js';
import './rail-row.js';

type Variant = 'files' | 'changes' | 'pages';
interface Args { variant:Variant }
const meta = {
  title:'UI/Rail Row', tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true},
  args:{variant:'files'},
  render:(args:Args) => html`<div style="box-sizing:border-box;width:min(310px,calc(100% - var(--ui-space-8)));margin:var(--ui-space-8) auto;padding:var(--ui-space-4) 0;border:1px solid var(--ui-border);border-radius:var(--ui-radius-lg);background:var(--ui-surface-raised)">
    ${args.variant === 'files' ? html`<div role="tree" aria-label="Project files">
      <mux-ui-rail-row tree directory .expanded=${true} .level=${1} label="docs"><span slot="chevron">${icon(ChevronDown,{size:13})}</span><span slot="icon">${icon(Folder,{size:16})}</span></mux-ui-rail-row>
      <mux-ui-rail-row tree .level=${2} .depth=${1} label="design-system.md" detail="6.1 KB" selected><span slot="icon">${icon(FileText,{size:16})}</span></mux-ui-rail-row>
      <mux-ui-rail-row tree directory .level=${1} label="src"><span slot="chevron">${icon(ChevronRight,{size:13})}</span><span slot="icon">${icon(Folder,{size:16})}</span></mux-ui-rail-row>
    </div>` : args.variant === 'changes' ? html`
      <mux-ui-rail-row label="README.md" detail="M" detail-tone="accent" selected><span slot="icon">${icon(FileText,{size:15})}</span></mux-ui-rail-row>
      <mux-ui-rail-row label="src/app.ts" detail="M" detail-tone="accent"><span slot="icon">${icon(GitCompare,{size:15})}</span></mux-ui-rail-row>
    ` : html`
      <mux-ui-rail-row label="Project notes" selected><span slot="icon">${icon(NotebookPen,{size:15})}</span></mux-ui-rail-row>
      <mux-ui-rail-row label="Review checklist" .depth=${1}><span slot="icon">${icon(NotebookPen,{size:15})}</span></mux-ui-rail-row>
    `}
  </div>`,
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const FileTree: Story = {};
export const Changes: Story = {args:{variant:'changes'}};
export const Pages: Story = {args:{variant:'pages'}};
export const PhoneFiles: Story = {globals:{viewport:{value:'phone390',isRotated:false}}};
export const Light: Story = {globals:{palette:'github-light'}};
