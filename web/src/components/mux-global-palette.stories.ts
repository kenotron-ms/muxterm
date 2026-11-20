import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import type { MuxGlobalPalette } from './mux-global-palette.js';
import './mux-global-palette.js';

const project = {id:'atlas',name:'Atlas',path:'/home/demo/atlas'};
const chat = {id:'atlas-chat',workspaceId:project.id,projectPath:project.path,title:'Atlas planning session',harness:'codex',state:'idle',createdAt:'2026-11-20T03:00:00Z'};
const fixture: ApiFixture = ({url,method}) => {
  if (method !== 'GET') return fixtureJSON({error:'Read only story'},405);
  if (url.pathname === '/api/sdk-chats') return url.searchParams.get('archived') === 'true' ? fixtureJSON({chats:[],total:0}) : fixtureJSON([chat]);
  if (url.pathname === '/api/sdk-projects') return fixtureJSON([project]);
  if (url.pathname === '/api/remotes') return fixtureJSON({connected:[],discovered:[],errors:[]});
  if (url.pathname === '/api/sdk-work') return fixtureJSON({work:[{id:'atlas-work',title:'Atlas release plan',projectIds:[project.id],status:'open'}]});
  if (url.pathname === '/api/sdk-projects/atlas/utility/search') return fixtureJSON({results:[{path:'docs/atlas-plan.md',name:'atlas-plan.md'}]});
  return fixtureJSON({error:`No palette fixture for ${url.pathname}`},404);
};

const meta = {
  title:'Composites/Global search and launch palette',
  tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true,apiFixture:fixture},
  render:() => html`<div style="min-height:100vh;background:var(--ui-surface-base)"><mux-global-palette open></mux-global-palette></div>`,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const searchAtlas: NonNullable<Story['play']> = async ({canvasElement}) => {
  const palette=canvasElement.querySelector<MuxGlobalPalette>('mux-global-palette');
  await palette?.updateComplete;
  const input=palette?.shadowRoot?.querySelector<HTMLInputElement>('input');
  if (!input) return;
  input.value='atlas';
  input.dispatchEvent(new Event('input',{bubbles:true}));
};

export const Suggestions: Story = {};
export const MixedResults: Story = {play:searchAtlas};
export const PhoneSuggestions: Story = {globals:{viewport:{value:'phone390',isRotated:false}}};
export const PhoneResults: Story = {globals:{viewport:{value:'phone390',isRotated:false}},play:searchAtlas};
