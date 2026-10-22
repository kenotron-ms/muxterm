import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import type { SDKChat } from '../lib/sdk-chats.js';
import './mux-operator-status.js';
import type { MuxOperatorStatus } from './mux-operator-status.js';

const baseChat: SDKChat = {
  id:'storybook-operator', title:'Release coordination', harness:'codex',
  projectPath:'/work/muxterm', state:'ready', createdAt:'2026-10-22T10:00:00Z',
};
const readyLane: SDKChat = {
  id:'lane-review', title:'Review accessibility', harness:'claude',
  projectPath:'/work/muxterm', state:'ready', createdAt:'2026-10-22T10:02:00Z',
  lastActivity:'Review completed', lastOutput:'Checked focus order and labels across the chat surface.',
  lastTurnOutcome:'completed', laneTodos:[
    {text:'Review focus order',status:'completed'},
    {text:'Check accessible names',status:'completed'},
    {text:'Report remaining gaps',status:'completed'},
  ],
  timing:{category:'review',classification:'anthropic',sampleSize:12,actualSeconds:144},
};
const workingLane: SDKChat = {
  id:'lane-build', title:'Build component catalog', harness:'codex',
  projectPath:'/work/muxterm', state:'working', createdAt:'2026-10-22T10:03:00Z',
  lastActivity:'Cataloging utility tabs', lastOutput:'Stories for the file browser and status panel are in progress.',
  laneTodos:[
    {text:'Catalog primitive controls',status:'completed'},
    {text:'Migrate utility views',status:'in_progress'},
    {text:'Capture browser evidence',status:'pending'},
  ],
  timing:{category:'focused',classification:'openai_decisions',sampleSize:12,elapsedSeconds:180,remainingLowSeconds:120,remainingHighSeconds:240,survivorCount:8},
};
const failedLane: SDKChat = {
  id:'lane-check', title:'Check deploy flow', harness:'pi',
  projectPath:'/work/muxterm', state:'uncertain', createdAt:'2026-10-22T10:04:00Z',
  lastActivity:'Needs review before continuing', lastOutput:'The last run ended without a confirmed result.',
};
const availableChat: SDKChat = {
  id:'chat-notes', title:'Design notes', harness:'opencode',
  projectPath:'/work/muxterm', state:'ready', createdAt:'2026-10-22T09:30:00Z',
};

function operatorFixture(initiallyOperator: boolean, initialLanes: SDKChat[], fail = false): ApiFixture {
  let operator = { ...baseChat, operator:initiallyOperator, operatorLanes:initialLanes.map(lane => lane.id) };
  const chats = [operator, readyLane, workingLane, failedLane, availableChat];
  return ({url, method, init}) => {
    if (url.pathname.endsWith('/api/sdk-projects')) return fixtureJSON([]);
    if (url.pathname.endsWith('/api/sdk-chats') && method === 'GET') return fixtureJSON(chats);
    if (url.pathname.endsWith(`/api/sdk-chats/${operator.id}/operator`)) {
      if (fail && method === 'GET') return new Response('Operator status is unavailable.', {status:503});
      if (method === 'GET') return fixtureJSON({operator, lanes:chats.filter(chat => operator.operatorLanes?.includes(chat.id))});
      if (method === 'PATCH') {
        const change = JSON.parse(String(init?.body || '{}')) as {enabled?:boolean;laneIds?:string[]};
        operator = { ...operator, operator:change.enabled ?? operator.operator, operatorLanes:change.laneIds ?? operator.operatorLanes };
        chats[0] = operator;
        return fixtureJSON(operator);
      }
      if (method === 'POST') {
        const {laneId} = JSON.parse(String(init?.body || '{}')) as {laneId:string};
        operator = { ...operator, operatorLanes:[...(operator.operatorLanes || []),laneId] };
        chats[0] = operator;
        return fixtureJSON(operator);
      }
    }
    return fixtureJSON({error:`No operator fixture for ${method} ${url.pathname}`}, 501);
  };
}

const meta = {
  title:'Composites/Operator status', tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true,apiFixture:operatorFixture(true,[readyLane,workingLane,failedLane])},
  render:() => html`<div style="box-sizing:border-box;max-width:700px;height:100vh;margin:auto"><mux-operator-status sessionId="storybook-operator"></mux-operator-status></div>`,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveLanes: Story = {};
async function expandFirstLane(canvasElement: HTMLElement) {
  const component = canvasElement.querySelector<MuxOperatorStatus>('mux-operator-status');
  for (let attempt=0; attempt<40 && !component?.shadowRoot?.querySelector('.lane-toggle'); attempt++)
    await new Promise(resolve=>window.setTimeout(resolve,50));
  component?.shadowRoot?.querySelector<HTMLButtonElement>('.lane-toggle')?.click();
}
export const ExpandedLane: Story = {play:async ({canvasElement})=>{await expandFirstLane(canvasElement);}};
export const EmptyOperator: Story = { parameters:{apiFixture:operatorFixture(true,[])} };
export const PromoteChat: Story = { parameters:{apiFixture:operatorFixture(false,[])} };
export const LoadError: Story = { parameters:{apiFixture:operatorFixture(true,[],true)} };
export const PhoneWithAttention: Story = {
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:operatorFixture(true,[workingLane,failedLane])},
};
export const PhoneExpandedLane: Story = {
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:ExpandedLane.play,
};
