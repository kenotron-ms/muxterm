import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import { sdkChats, type SDKChat } from '../lib/sdk-chats.js';
import type { MuxChatCoordination } from './mux-chat-coordination.js';
import './mux-chat-coordination.js';

const owner = 'storybook-coordination-owner';
const sourceA = 'storybook-coordination-build';
const sourceB = 'storybook-coordination-review';
const now = '2026-11-01T18:30:00Z';
const chats: SDKChat[] = [
  { id:owner, title:'Release coordination', harness:'codex', state:'ready', projectPath:'/work/muxterm', createdAt:now },
  { id:sourceA, title:'Build artifacts', harness:'copilot', state:'ready', projectPath:'/work/muxterm', createdAt:now },
  { id:sourceB, title:'Review UX', harness:'pi', state:'ready', projectPath:'/work/muxterm', createdAt:now },
];
const work = {
  id:'storybook-coordination-work', title:'Ship session coordination', brief:'Review the inbox and publish the release.',
  status:'active', progress:'Browser verification complete; waiting for review.', ownerSessionId:owner,
  sessionIds:[sourceA,sourceB], updatedAt:now,
  updates:[
    {id:'update-1',at:now,sessionId:owner,text:'Started the release review.',status:'active'},
    {id:'update-2',at:now,sessionId:sourceB,text:'Checked the Coordination view at desktop and phone widths.'},
  ],
};
const events = [
  {id:'inbox-1',sourceSessionId:sourceA,topic:'lifecycle',at:now,event:{type:'turn.completed',text:'Build artifacts are ready.'}},
  {id:'inbox-2',sourceSessionId:sourceB,topic:'work',at:now,event:{type:'work.updated',text:'Review is complete.'}},
];

const coordinationFixture: ApiFixture = ({url,method}) => {
  if (method === 'GET' && url.pathname === '/api/sdk-work') return fixtureJSON({work:[work]});
  if (method === 'GET' && url.pathname === `/api/sdk-work/${work.id}`) return fixtureJSON(work);
  if (method === 'GET' && url.pathname === `/api/sdk-chats/${owner}/subscriptions`)
    return fixtureJSON({subscriptions:[{id:'subscription-1',sources:[sourceA,sourceB],topics:['lifecycle','work']}]});
  if (method === 'GET' && url.pathname === `/api/sdk-chats/${owner}/inbox`)
    return fixtureJSON({events:url.searchParams.get('after') === '0' ? events : [],cursor:2,hasMore:false});
  return fixtureJSON({error:`No coordination fixture for ${method} ${url.pathname}`},501);
};

const meta = {
  title:'Screens/Coordination', tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true,apiFixture:coordinationFixture},
  render:() => {
    sdkChats.chats = chats;
    return html`<div style="height:100vh"><mux-chat-coordination .sessionId=${owner}></mux-chat-coordination></div>`;
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Work: Story = {};
async function showView(canvasElement: HTMLElement, label: string) {
  const component = canvasElement.querySelector<MuxChatCoordination>('mux-chat-coordination');
  await component?.updateComplete;
  [...(component?.shadowRoot?.querySelectorAll<HTMLElement>('nav mux-ui-button') ?? [])].find(button => button.textContent?.trim() === label)?.click();
}
export const Inbox: Story = {play:async ({canvasElement}) => showView(canvasElement,'Inbox')};
export const Subscriptions: Story = {play:async ({canvasElement}) => showView(canvasElement,'Subscriptions')};
export const PhoneInbox: Story = {globals:{viewport:{value:'phone390',isRotated:false}},play:Inbox.play};
