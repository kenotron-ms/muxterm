import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { FileText, Search } from 'lucide';
import { icon } from '../lib/icons.js';
import type { CommandSearchItem } from './command-search.js';
import './command-search.js';

const items: CommandSearchItem[] = [
  {id:'docs/design-system.md',label:'design-system.md',description:'docs/design-system.md',detail:'608 B',icon:FileText},
  {id:'docs/component-library.md',label:'component-library.md',description:'docs/component-library.md',detail:'1.2 KB',icon:FileText},
  {id:'README.md',label:'README.md',description:'README.md',detail:'1.2 KB',icon:FileText},
];

interface Args { query:string; items:CommandSearchItem[]; loading:boolean; error:string; emptyMessage:string; hint:string; footer:string }
const meta = {
  title:'Primitives/Command search', tags:['autodocs'],
  args:{query:'design',items,loading:false,error:'',emptyMessage:'No matching files.',hint:'Type at least two characters to search the project.',footer:''},
  render:(args:Args) => html`<div style="width:min(480px,100%);border:1px solid var(--ui-border);border-radius:var(--ui-radius-lg);background:var(--ui-surface-overlay);overflow:hidden"><mux-ui-command-search aria-label="Search project files" placeholder="Search files by name…" .query=${args.query} .items=${args.items} ?loading=${args.loading} .error=${args.error} .emptyMessage=${args.emptyMessage} .hint=${args.hint} .footer=${args.footer}><span slot="icon">${icon(Search,{size:18})}</span></mux-ui-command-search></div>`,
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const Results: Story = {};
export const PhoneResults: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const LightResults: Story = { globals:{palette:'github-light'} };
export const Initial: Story = { args:{query:'',items:[]} };
export const Loading: Story = { args:{items:[],loading:true} };
export const NoResults: Story = { args:{items:[]} };
export const Error: Story = { args:{items:[],error:'File search is unavailable. Try again.'} };
export const Truncated: Story = { args:{footer:'Showing the first matches. Narrow your search for more.'} };
