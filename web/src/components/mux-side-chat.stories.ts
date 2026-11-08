import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import './mux-side-chat.js';

const parentId = 'storybook-main-chat';
const fixture: ApiFixture = ({ url, method }) => {
  if (method === 'GET' && url.pathname === '/api/sdk-chats' && url.searchParams.get('sideParentId') === parentId) return fixtureJSON([]);
  return fixtureJSON({ error:`No side chat fixture for ${method} ${url.pathname}` }, 501);
};

const meta = {
  title:'Screens/Side Chat', tags:['autodocs'],
  parameters:{ layout:'fullscreen', fullBleed:true, apiFixture:fixture },
  render:() => html`<div style="height:100vh"><mux-side-chat .sessionId=${parentId} tabId="storybook-draft"></mux-side-chat></div>`,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Start: Story = {};
export const Phone: Story = { parameters:{ viewport:{ defaultViewport:'mobile1' } } };
