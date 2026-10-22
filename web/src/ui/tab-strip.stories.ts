import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { FileText, Folder, GitCompare, Network, NotebookPen } from 'lucide';
import { icon } from '../lib/icons.js';
import './tab-strip.js';
import type { MuxUITabStrip, TabStripItem } from './tab-strip.js';

const tabs: TabStripItem[] = [
  {id:'files',label:'Files',icon:icon(Folder,{size:14})},
  {id:'readme',label:'README.md',icon:icon(FileText,{size:14})},
  {id:'status',label:'Status',icon:icon(Network,{size:14})},
  {id:'changes',label:'Changes',icon:icon(GitCompare,{size:14})},
  {id:'pages',label:'Pages',icon:icon(NotebookPen,{size:14})},
];

interface Args { many:boolean; activeId:string }
const meta = {
  title:'UI/Tab Strip', tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true},
  args:{many:false,activeId:'readme'},
  render:(args:Args) => {
    const items = args.many ? [...tabs,{id:'design',label:'design-system.md',icon:icon(FileText,{size:14})},{id:'notes',label:'Review notes',icon:icon(NotebookPen,{size:14})}] : tabs.slice(0,3);
    return html`<mux-ui-tab-strip accessible-label="Review tools" .tabs=${items} .activeId=${args.activeId}
      @tab-select=${(event:CustomEvent<{id:string}>) => { (event.currentTarget as MuxUITabStrip).activeId = event.detail.id; }}
      @tab-close=${(event:CustomEvent<{id:string}>) => {
        const strip = event.currentTarget as MuxUITabStrip;
        const index = strip.tabs.findIndex(item => item.id === event.detail.id);
        strip.tabs = strip.tabs.filter(item => item.id !== event.detail.id);
        if (strip.activeId === event.detail.id) strip.activeId = strip.tabs[Math.min(index,strip.tabs.length-1)]?.id || '';
      }}
      @tab-add=${(event:Event) => {
        const strip = event.currentTarget as MuxUITabStrip;
        const id = `new-${strip.tabs.length}`;
        strip.tabs = [...strip.tabs,{id,label:'New tab'}]; strip.activeId = id;
      }}></mux-ui-tab-strip>`;
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const Default: Story = {};
export const ManyTabs: Story = { args:{many:true,activeId:'changes'} };
export const Phone: Story = { args:{many:true,activeId:'changes'},globals:{viewport:{value:'phone390',isRotated:false}} };
export const Light: Story = { args:{many:true,activeId:'pages'},globals:{palette:'github-light'} };
