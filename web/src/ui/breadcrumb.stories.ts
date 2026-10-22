import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './breadcrumb.js';

const project = [
  {id:'.',label:'muxterm',actionLabel:'Show project files'},
  {id:'web',label:'web',actionLabel:'Show web in file browser'},
  {id:'web/src',label:'src',actionLabel:'Show src in file browser'},
  {id:'web/src/ui',label:'ui',actionLabel:'Show ui in file browser'},
  {id:'web/src/ui/tokens.css',label:'tokens.css'},
];
const meta = {title:'Primitives/Breadcrumb',tags:['autodocs'],render:() => html`<div style="width:min(560px,100%);padding:var(--ui-space-4);background:var(--ui-surface-raised)"><mux-ui-breadcrumb label="Open file path" .items=${project}></mux-ui-breadcrumb></div>`} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ProjectFile: Story = {};
export const PhonePath: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const DocumentPage: Story = {render:() => html`<div style="width:300px;padding:var(--ui-space-4);background:var(--ui-document-surface)"><mux-ui-breadcrumb appearance="document" label="Page path" .items=${[{id:'parent',label:'Document actions review',actionLabel:'Open parent page Document actions review'},{id:'child',label:'Phone child review of document actions'}]}></mux-ui-breadcrumb></div>`};
export const Empty: Story = {render:() => html`<mux-ui-breadcrumb label="Open file path" placeholder="Open a file to preview it"></mux-ui-breadcrumb>`};
export const Light: Story = {globals:{palette:'github-light'}};
