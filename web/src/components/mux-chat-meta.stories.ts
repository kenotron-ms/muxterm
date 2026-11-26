import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import type { MetaEvent } from '../lib/chat-meta.js';
import './mux-chat-meta.js';

const sessionId = 'storybook-chat-meta';
const events: MetaEvent[] = [
  {type:'turn.started', generationId:'first', at:'2026-11-25T10:00:00Z'},
  {type:'assistant.delta', at:'2026-11-25T10:00:01Z'},
  {type:'tool.started', toolId:'first-tool'},
  {type:'tool.completed', toolId:'first-tool'},
  {type:'usage.observed', kind:'thread-total', generationId:'first', raw:{inputTokens:1200, outputTokens:70, cachedInputTokens:0}},
  {type:'turn.completed', generationId:'first', at:'2026-11-25T10:00:03Z'},
  {type:'turn.started', generationId:'second', at:'2026-11-25T10:00:08Z'},
  {type:'assistant.delta', at:'2026-11-25T10:00:09Z'},
  {type:'usage.observed', kind:'thread-total', generationId:'second', raw:{inputTokens:2650, outputTokens:175, cachedInputTokens:1024}},
  {type:'turn.completed', generationId:'second', at:'2026-11-25T10:00:12Z'},
];
const fixture: ApiFixture = ({url, method}) => {
  if (method === 'GET' && url.pathname === `/api/sdk-chats/${sessionId}/history` && url.searchParams.get('view') === 'meta') {
    return fixtureJSON({from:0, to:events.length, hasMore:false, events});
  }
  return fixtureJSON({error:'No fixture for this request'}, 404);
};

const meta = {
  title:'Screens/Chat Meta',
  parameters:{apiFixture:fixture},
  render:() => html`<mux-chat-meta .sessionId=${sessionId}></mux-chat-meta>`,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const PartialUsage: Story = {};
export const Phone: Story = {globals:{viewport:{value:'phone390', isRotated:false}}};
