import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import { sdkChats, type SDKChat } from '../lib/sdk-chats.js';
import type { MuxChatCoordination } from './mux-chat-coordination.js';
import './mux-chat-coordination.js';

const projectId = 'storybook-project';
const intake = 'storybook-work-intake';
const builder = 'storybook-work-builder';
const reviewer = 'storybook-work-reviewer';
const now = '2026-11-18T18:30:00Z';
const chats: SDKChat[] = [
  { id:intake, workspaceId:projectId, title:'Member welcome planning', harness:'codex', state:'ready', projectPath:'/work/member-welcome', createdAt:now },
  { id:builder, workspaceId:projectId, title:'Build invitations', harness:'codex', state:'working', projectPath:'/work/member-welcome', createdAt:now },
  { id:reviewer, workspaceId:projectId, title:'Review onboarding', harness:'codex', state:'ready', projectPath:'/work/member-welcome', createdAt:now },
];
const base = { createdBy:{kind:'chat',sessionId:intake}, reviewerSessionId:'', sessionIds:[], projectIds:[projectId], labels:[], dependsOn:[], waitingOn:[], ownerSessionId:'', revision:2, createdAt:now, updatedAt:now, updates:[] };
const work = [
  { ...base, id:'invite-copy', title:'Review invitation wording', brief:'Check the welcome invitation before the pilot goes out.', status:'review', readiness:'ready', progress:'Copy and examples are ready to inspect.', labels:['onboarding','pilot'], updates:[{id:'review-update',at:now,actor:{kind:'chat',sessionId:builder},status:'review',text:'Drafted two versions and shared the preview.',evidence:['Preview in worker chat']}] },
  { ...base, id:'launch-date', title:'Choose a launch date', brief:'The invitation schedule needs a date.', status:'blocked', readiness:'ready', needsHuman:true, blockedReason:'Choose which week the pilot should begin.', labels:['pilot'] },
  { ...base, id:'build-invites', title:'Build invitation flow', brief:'Let members accept an invitation and finish their welcome.', status:'active', readiness:'ready', ownerSessionId:builder, progress:'The first browser flow is running.', nextAction:'Verify the invite link on mobile.', labels:['onboarding','frontend'], updates:[{id:'build-update',at:now,actor:{kind:'chat',sessionId:builder},status:'active',text:'Started the invitation flow.'}] },
  { ...base, id:'search', title:'Add project search', brief:'Find a project by name from the switcher.', status:'open', readiness:'ready', nextAction:'Create the search interaction.', labels:['navigation'] },
  { ...base, id:'docs', title:'Document project search', brief:'Explain search once it ships.', status:'open', readiness:'ready', dependsOn:['search'], waitingOn:['search'], nextAction:'Draft a short guide.', labels:['docs'] },
  { ...base, id:'provider', title:'Check provider credentials', brief:'Confirm the pilot account can use the selected model.', status:'blocked', readiness:'ready', needsHuman:false, blockedReason:'Waiting for the provider to finish provisioning.', labels:['pilot'] },
  { ...base, id:'welcome-email', title:'Write welcome email', brief:'Prepare the welcome note for new members.', status:'open', readiness:'draft', labels:['onboarding'] },
  { ...base, id:'goal-review', title:'Plan the member welcome pilot', brief:'Make the first invitation flow understandable and reliable for new members.', status:'open', readiness:'draft', goalCondition:'Finish when the invitation can be sent, accepted, and verified in a real browser on desktop and phone, with the result and any remaining gaps recorded in Work. If access or dependencies prevent verification, record the blocker and stop for a human decision.', goalRevision:1, goalApprovedRevision:0, labels:['onboarding','pilot'] },
  { ...base, id:'signup', title:'Build signup form', brief:'Create the signup form and verify it in a browser.', status:'done', readiness:'ready', outcome:'Verified the signup path at desktop and phone widths.', labels:['onboarding'] },
];
let control = {projectId, paused:false, parallelism:4, version:1, active:1};
const fixture: ApiFixture = ({url,method,init}) => {
  if (url.pathname === '/api/sdk-work' && method === 'GET' && url.searchParams.get('project_id') === projectId) return fixtureJSON({work});
  if (url.pathname.startsWith('/api/sdk-work/') && method === 'GET') return fixtureJSON(work.find(item => item.id === url.pathname.split('/').at(-1)));
  if (url.pathname === `/api/sdk-projects/${projectId}/work-control`) {
    if (method === 'PATCH') {
      const body = JSON.parse(String(init?.body || '{}')) as {paused?:boolean;parallelism?:number;expectedVersion?:number};
      if (body.expectedVersion !== control.version) return fixtureJSON({error:'Project work controls changed; refresh.'},409);
      control = {...control, paused:body.paused ?? control.paused, parallelism:body.parallelism ?? control.parallelism, version:control.version+1};
    }
    return fixtureJSON(control);
  }
  return fixtureJSON({error:`No Work fixture for ${method} ${url.pathname}`},501);
};

const meta = {
  title:'Screens/Work', tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true,apiFixture:fixture},
  render:() => {
    sdkChats.chats = chats;
    sdkChats.projects = [{id:projectId,name:'Member welcome',path:'/work/member-welcome'}];
    control = {projectId, paused:false, parallelism:4, version:1, active:1};
    return html`<div style="height:100vh"><mux-chat-coordination .sessionId=${intake} .projectId=${projectId}></mux-chat-coordination></div>`;
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const openDetail = (title:string):NonNullable<Story['play']> => async ({canvasElement}) => {
  const view = canvasElement.querySelector<MuxChatCoordination>('mux-chat-coordination');
  for (let attempt=0; attempt<80; attempt++) {
    await view?.updateComplete;
    const button = [...(view?.shadowRoot?.querySelectorAll('mux-ui-button') || [])].find(element => element.textContent?.includes(title));
    if (button) { button.click(); await view?.updateComplete; return; }
    await new Promise(resolve => setTimeout(resolve,25));
  }
  throw new Error(`Work item ${title} did not appear`);
};

export const Inbox: Story = {};
export const InboxPhone: Story = {globals:{viewport:{value:'phone390',isRotated:false}}};
export const Detail: Story = {play:openDetail('Build invitation flow')};
export const DetailPhone: Story = {globals:{viewport:{value:'phone390',isRotated:false}},play:openDetail('Build invitation flow')};
export const GoalReview: Story = {play:openDetail('Plan the member welcome pilot')};
export const GoalReviewPhone: Story = {globals:{viewport:{value:'phone390',isRotated:false}},play:openDetail('Plan the member welcome pilot')};
