import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import type { WorkGoalReviewItem } from './work-goal-review.js';
import './work-goal-review.js';

const item: WorkGoalReviewItem = {
  id:'member-welcome-goal', title:'Plan the member welcome pilot', revision:3,
  status:'open', readiness:'draft', goalRevision:1, goalApprovedRevision:0,
  goalCondition:'Finish when the invitation can be sent, accepted, and verified in a real browser on desktop and phone, with the result recorded in Work. If access or dependencies prevent verification, record the blocker and stop for a human decision.',
};
const fixture: ApiFixture = ({url,method,init}) => {
  if (url.pathname === `/api/sdk-work/${item.id}/goal/approve` && method === 'POST') {
    const body=JSON.parse(String(init?.body || '{}')) as {ready?:boolean};
    return fixtureJSON({...item,revision:item.revision+1,goalApprovedRevision:1,readiness:body.ready?'ready':'draft'});
  }
  if (url.pathname === `/api/sdk-work/${item.id}/updates` && method === 'POST') return fixtureJSON({...item,revision:item.revision+2,goalApprovedRevision:1,readiness:'ready'});
  return fixtureJSON({error:`No Work goal fixture for ${method} ${url.pathname}`},501);
};

const meta: Meta<{item:WorkGoalReviewItem}> = {
  title:'Composites/Work goal review', tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true,apiFixture:fixture},
  render:(args:{item:WorkGoalReviewItem}) => html`<div style="min-height:100vh;padding:40px;max-width:760px;background:var(--ui-surface-base);color:var(--ui-text)"><mux-work-goal-review .item=${args.item}></mux-work-goal-review></div>`,
  args:{item},
};
export default meta;
type Story = StoryObj<{item:WorkGoalReviewItem}>;

export const Draft: Story = {};
export const DraftPhone: Story = {globals:{viewport:{value:'phone390',isRotated:false}}};
export const Approved: Story = {args:{item:{...item,revision:4,goalApprovedRevision:1}}};
