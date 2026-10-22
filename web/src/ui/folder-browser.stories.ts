import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import type { FolderBrowserListing } from './folder-browser.js';
import './folder-browser.js';

interface FolderBrowserArgs { listing:FolderBrowserListing; allowNewFolder:boolean }
const meta = {
  title:'Components/Folder Browser', tags:['autodocs'],
  args:{listing:{path:'/home/demo/atlas',parent:'/home/demo',folders:['docs','web','design']} as FolderBrowserListing,allowNewFolder:true},
  render:(args:FolderBrowserArgs) => html`<div style="box-sizing:border-box;min-height:460px;padding:var(--ui-space-7);background:var(--ui-surface-base);color:var(--ui-text)"><div style="width:min(420px,100%)"><mux-ui-folder-browser .listing=${args.listing} ?allow-new-folder=${args.allowNewFolder}></mux-ui-folder-browser></div></div>`,
} satisfies Meta<FolderBrowserArgs>;
export default meta;
type Story = StoryObj<FolderBrowserArgs>;
export const WithSubfolders: Story = {};
export const EmptyFolder: Story = { args:{listing:{path:'/home/demo/atlas/docs',parent:'/home/demo/atlas',folders:[]}} };
export const ProjectEditor: Story = { args:{allowNewFolder:false} };
export const Phone: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const Light: Story = { globals:{palette:'github-light'} };
