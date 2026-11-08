import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import './mux-side-chat.js';

const parentId = 'storybook-main-chat';
const earlier = [
  { id:'storybook-side-one', title:'How does the parser work?', sideParentId:parentId, harness:'codex', state:'ready', workspaceId:'project-1', projectPath:'/home/demo/muxterm', createdAt:'2026-10-22T10:00:00Z' },
  { id:'storybook-side-two', title:'Explain the layout', sideParentId:parentId, harness:'codex', state:'ready', workspaceId:'project-1', projectPath:'/home/demo/muxterm', createdAt:'2026-10-22T09:00:00Z' },
];

const fixture = (withEarlier = false): ApiFixture => ({ url, method }) => {
  if (method === 'GET' && url.pathname === '/api/sdk-chats' && url.searchParams.get('sideParentId') === parentId) return fixtureJSON(withEarlier ? earlier : []);
  return fixtureJSON({ error:`No side chat fixture for ${method} ${url.pathname}` }, 501);
};

const meta = {
  title:'Screens/Side Chat', tags:['autodocs'],
  parameters:{ layout:'fullscreen', fullBleed:true, apiFixture:fixture() },
  render:() => html`<div style="height:100vh"><mux-side-chat .sessionId=${parentId}></mux-side-chat></div>`,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Start: Story = {};
export const EarlierChats: Story = { parameters:{ apiFixture:fixture(true) } };
export const Phone: Story = { parameters:{ viewport:{ defaultViewport:'mobile1' }, apiFixture:fixture(true) } };
