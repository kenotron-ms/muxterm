import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import './mux-scheduled-jobs.js';

const now = Date.now();
const iso = (offsetHours: number) => new Date(now + offsetHours * 3600_000).toISOString();
const chats = [
  { id:'chat-release', title:'Release notes', projectPath:'/projects/muxterm', harness:'codex', state:'idle', createdAt:iso(-240) },
  { id:'chat-health', title:'Service health', projectPath:'/projects/ops', harness:'codex', state:'idle', createdAt:iso(-200) },
  { id:'chat-report', title:'Weekly report', projectPath:'/projects/reports', harness:'codex', state:'idle', createdAt:iso(-160) },
  { id:'chat-review', title:'Pull request review', projectPath:'/projects/muxterm', harness:'codex', state:'idle', createdAt:iso(-120) },
  { id:'chat-draft', title:'Customer update draft', projectPath:'/projects/reports', harness:'codex', state:'idle', createdAt:iso(-24) },
];
const jobs = [
  { id:'job-release', chatId:'chat-release', name:'Release notes', brief:'Summarize changes and draft release notes.', revision:2, schedule:'0 9 * * 1-5', scheduleLabel:'Weekdays at 9am', timezone:'UTC', enabled:true, nextRun:iso(14), createdAt:iso(-120) },
  { id:'job-health', chatId:'chat-health', name:'Service health', brief:'Check service status and summarize incidents.', revision:1, schedule:'0 * * * *', scheduleLabel:'Every hour', timezone:'UTC', enabled:true, activeRunId:'run-health', nextRun:iso(1), createdAt:iso(-96) },
  { id:'job-report', chatId:'chat-report', name:'Weekly report', brief:'Collect project updates for the team.', revision:1, schedule:'0 10 * * 1', scheduleLabel:'Mondays at 10am', timezone:'UTC', enabled:false, createdAt:iso(-72) },
  { id:'job-review', chatId:'chat-review', name:'Pull request review', brief:'Review new pull requests and summarize risks.', revision:3, schedule:'0 16 * * 1-5', scheduleLabel:'Weekdays at 4pm', timezone:'UTC', enabled:true, nextRun:iso(21), createdAt:iso(-48), latestRun:{ id:'run-review', jobId:'job-review', chatId:'chat-review', trigger:'scheduled', status:'failed', startedAt:iso(-3), finishedAt:iso(-2.9) } },
];
const reviewRun = {
  id:'run-review', jobId:'job-review', chatId:'chat-review', trigger:'scheduled',
  revision:3, status:'failed', startedAt:iso(-3), finishedAt:iso(-2.9),
  summary:'The review stopped before it could post a summary.',
  logs:[
    {at:iso(-3),kind:'started',message:'Opened the review conversation.'},
    {at:iso(-2.9),kind:'error',message:'The repository service was unavailable.'},
  ],
};

function jobsFixture(rows: unknown[]): ApiFixture {
  return ({ url, method }) => {
    if (method !== 'GET') return fixtureJSON({ error:'This Storybook example shows job state; use dev-local to edit or run jobs.' }, 501);
    if (url.pathname.endsWith('/api/sdk-jobs')) return fixtureJSON(rows);
    if (url.pathname.endsWith('/api/sdk-chats')) return fixtureJSON(chats);
    if (url.pathname.endsWith('/api/sdk-projects')) return fixtureJSON([]);
    if (url.pathname.endsWith('/api/sdk-jobs/job-review/runs/run-review')) return fixtureJSON(reviewRun);
    if (url.pathname.endsWith('/api/sdk-jobs/job-review/runs')) return fixtureJSON([reviewRun]);
    if (/\/api\/sdk-jobs\/[^/]+\/runs$/.test(url.pathname)) return fixtureJSON([]);
    return fixtureJSON({ error:`No story fixture for ${url.pathname}` }, 404);
  };
}

const meta = {
  title: 'Screens/Scheduled jobs',
  tags: ['autodocs'],
  parameters: { layout:'fullscreen', apiFixture:jobsFixture(jobs) },
  render: () => html`<mux-scheduled-jobs></mux-scheduled-jobs>`,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;
export const Statuses: Story = {};
export const PhoneStatuses: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const Empty: Story = { parameters: { apiFixture:jobsFixture([]) } };
export const NewJobEditor: Story = { play:async ({canvasElement}) => {
  const host = canvasElement.querySelector('mux-scheduled-jobs');
  await host?.updateComplete;
  host?.shadowRoot?.querySelector<HTMLElement>('mux-ui-page-intro mux-ui-button[slot="action"]')?.click();
} };
export const PhoneNewJobEditor: Story = {
  ...NewJobEditor,
  globals:{viewport:{value:'phone390',isRotated:false}},
};
export const EditJobEditor: Story = { play:async ({canvasElement}) => {
  const host = canvasElement.querySelector('mux-scheduled-jobs');
  for (let attempt=0;attempt<100;attempt++) {
    const row = [...(host?.shadowRoot?.querySelectorAll('tbody tr') ?? [])].find(item=>item.textContent?.includes('Release notes'));
    const action = row?.querySelector<HTMLElement>('.row-actions mux-ui-button:last-child');
    if (action?.shadowRoot?.querySelector('button')) { action.click(); return; }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('Release notes Edit action did not appear');
} };
export const PausedJobEditor: Story = { play:async ({canvasElement}) => {
  const host = canvasElement.querySelector('mux-scheduled-jobs');
  for (let attempt=0;attempt<100;attempt++) {
    const row = [...(host?.shadowRoot?.querySelectorAll('tbody tr') ?? [])].find(item=>item.textContent?.includes('Weekly report'));
    const action = row?.querySelector<HTMLElement>('.row-actions mux-ui-button:last-child');
    if (action?.shadowRoot?.querySelector('button')) { action.click(); return; }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('Weekly report Edit action did not appear');
} };
export const FailedRunHistory: Story = { play:async ({canvasElement}) => {
  const host = canvasElement.querySelector('mux-scheduled-jobs');
  for (let attempt=0;attempt<100;attempt++) {
    const row = [...(host?.shadowRoot?.querySelectorAll('tbody tr') ?? [])].find(item=>item.textContent?.includes('Pull request review'));
    const action = row?.querySelector<HTMLElement>('.row-actions mux-ui-button:nth-child(2)');
    if (action?.shadowRoot?.querySelector('button')) { action.click(); return; }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('Pull request review History action did not appear');
} };
