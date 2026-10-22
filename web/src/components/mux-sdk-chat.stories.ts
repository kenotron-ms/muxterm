import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import { sdkChats, type SDKChat } from '../lib/sdk-chats.js';
import type { MuxSDKChat } from './mux-sdk-chat.js';
import './mux-sdk-chat.js';
import './title-bar.js';

type ChatEvent = {
  at:string; type:string; text?:string; kind?:string; source?:string;
  inputId?:string; inputIds?:string[]; itemId?:string; complete?:boolean;
  toolId?:string; name?:string; raw?:unknown; summary?:boolean;
  agent?:string; childSessionId?:string; parentSessionId?:string;
  origin?:{type:'operator-lane'|'chat-message';chatId:string;name:string;harness:string;status:string;relation?:'chat-to-chat'};
};

const at = (second: number) => `2026-10-22T10:00:${String(second).padStart(2,'0')}Z`;
const transcript: ChatEvent[] = [
  {at:at(1),type:'input.accepted',kind:'user',source:'browser',inputId:'message-1',text:'Can you review the component catalog and tell me what to tackle next?'},
  {at:at(2),type:'commentary.delta',itemId:'progress-1',text:'I’m checking the catalog and the remaining open screens.',complete:true},
  {at:at(3),type:'tool.started',toolId:'tool-1',name:'functions.exec',raw:{cmd:'rg "Open" docs/design-system/inventory.md'}},
  {at:at(4),type:'tool.completed',toolId:'tool-1',name:'functions.exec',raw:{type:'commandExecution',exitCode:0,status:'completed',aggregatedOutput:'Main chat, utility, dock, and document previews remain open.'}},
  {at:at(7),type:'assistant.delta',text:'The next useful pass is the **main chat surface**. Catalog its transcript, work disclosure, and composer states together.\n\nThen review the utility pane and document previews at phone width.'},
  {at:at(8),type:'turn.completed',inputIds:['message-1']},
  {at:at(12),type:'input.accepted',kind:'user',source:'browser',inputId:'message-2',text:'Show me how a completed tool call appears.'},
  {at:at(13),type:'commentary.delta',itemId:'progress-2',text:'I’ll open the work details so the command and result are visible.',complete:true},
  {at:at(14),type:'tool.started',toolId:'tool-2',name:'functions.exec',raw:{cmd:'npm run check:fast'}},
  {at:at(16),type:'tool.completed',toolId:'tool-2',name:'functions.exec',raw:{type:'commandExecution',exitCode:0,status:'completed',aggregatedOutput:'Typecheck and lint completed with zero errors.'}},
  {at:at(18),type:'assistant.delta',text:'The check passed with zero errors. The command and output are available in the work disclosure above.'},
  {at:at(19),type:'turn.completed',inputIds:['message-2']},
];

const running: ChatEvent[] = [
  ...transcript,
  {at:at(25),type:'input.accepted',kind:'user',source:'browser',inputId:'message-3',text:'Now inspect the phone composer and report any seams.'},
  {at:at(26),type:'commentary.delta',itemId:'progress-3',text:'I’m comparing the phone composer with the shared controls.',complete:true},
];

const delegated: ChatEvent[] = [
  {at:at(1),type:'input.accepted',kind:'user',source:'browser',inputId:'delegation-1',text:'Ask the design agent to review the chat controls.'},
  {at:at(2),type:'tool.started',toolId:'delegate-tool',name:'delegate',raw:{prompt:'Review the chat controls and report remaining seams.'}},
  {at:at(3),type:'delegate.spawned',toolId:'delegate-tool',childSessionId:'design-agent-1',agent:'Design review'},
  {at:at(4),type:'delegate.message',childSessionId:'design-agent-1',text:'Comparing shared controls with the chat surface.',complete:true},
  {at:at(5),type:'delegate.completed',childSessionId:'design-agent-1',agent:'Design review'},
  {at:at(6),type:'assistant.delta',text:'The delegated review is complete. Open its card to inspect the work.'},
  {at:at(7),type:'turn.completed',inputIds:['delegation-1']},
];
const linkedReports: ChatEvent[] = [
  {at:at(1),type:'operator.lane.report',childSessionId:'linked-lane-1',text:'**Catalog review complete.** The shared controls now cover the chat toolbar and composer.',origin:{type:'operator-lane',chatId:'linked-lane-1',name:'Design review lane',harness:'codex',status:'ready'}},
  {at:at(2),type:'input.accepted',kind:'user',source:'browser',inputId:'report-1',text:'Show the linked report and source message.'},
  {at:at(3),type:'input.accepted',text:'Please check the phone controls too.',origin:{type:'chat-message',chatId:'source-chat-1',name:'Companion chat',harness:'codex',status:'ready',relation:'chat-to-chat'}},
  {at:at(4),type:'assistant.delta',text:'Both linked items can be expanded or opened from the source action.'},
  {at:at(5),type:'turn.completed',inputIds:['report-1']},
];
const failedLinkedReports: ChatEvent[] = [
  {at:at(1),type:'operator.lane.report',childSessionId:'linked-lane-1',text:'**Catalog review stopped.** The component scan did not finish.',origin:{type:'operator-lane',chatId:'linked-lane-1',name:'Design review lane',harness:'codex',status:'failed'}},
  ...linkedReports.slice(1),
];

const settings = {
  model:'gpt-6-sol', effort:'medium', permission:'full-permission', mode:'agent',
  permissions:['read-only','workspace-write','full-permission'], modes:['agent','plan'],
  models:[
    {id:'gpt-6-astra',label:'GPT-6-Astra',efforts:['low','medium','high'],defaultEffort:'medium'},
    {id:'gpt-6-sol',label:'GPT-6-Sol',efforts:['low','medium','high'],defaultEffort:'medium'},
  ],
};

function chatFixture(id:string, state:'ready'|'working'|'uncertain' = 'ready', goalState:'none'|'active'|'proposal' = 'none', scenario:'default'|'delegated'|'reports'|'failed-report' = 'default'): ApiFixture {
  let historyRequests = 0;
  const chat: SDKChat = {
    id, title:'Component library review', workspaceId:'project-1',
    projectPath:'/home/demo/muxterm', harness:'codex', state,
    createdAt:'2026-10-22T10:00:00Z',
  };
  const operator: SDKChat = {
    id:'storybook-operator', title:'Design system operator', workspaceId:'project-1',
    projectPath:'/home/demo/muxterm', harness:'codex', state:'working', operator:true,
    operatorLanes:[id], createdAt:'2026-10-22T09:00:00Z',
  };
  const goal = {
    schema:1, chatId:id, harness:'codex', version:goalState === 'none' ? 0 : 3,
    controlVersion:goalState === 'none' ? 0 : 3,
    requestedRevision:goalState === 'none' ? 0 : 1,
    appliedRevision:goalState === 'none' ? 0 : 1,
    humanPaused:false, state:goalState === 'none' ? 'not-set' : 'active',
    ...(goalState === 'proposal' ? {operatorId:operator.id} : {}),
    gap:'',
    revisions:goalState === 'none' ? [] : [{revision:1,condition:'Catalog every shared control, then stop after browser review.',provenance:'human',at:at(1)}],
    receipts:goalState === 'none' ? [] : [
      {id:'goal-start',action:'set',revision:1,actor:'human',status:'recorded',at:at(2)},
      ...(goalState === 'proposal' ? [{id:'goal-proposal',action:'propose',revision:2,actor:'agent',status:'recorded',objective:'Review and replace remaining chat one-offs.',at:at(3)}] : []),
    ],
    observations:goalState === 'none' ? [] : [{at:at(4),event:{type:'goal.started',goalState:'active',goalSummary:'The native harness acknowledged revision 1.'}}],
  };
  const events = scenario === 'delegated' ? delegated : scenario === 'reports' ? linkedReports : scenario === 'failed-report' ? failedLinkedReports : state === 'working' ? running : transcript;
  const messages = events.filter(event => event.type !== 'tool.started' && event.type !== 'tool.completed');
  return ({url,method,init}) => {
    if (method === 'GET' && url.pathname.endsWith('/api/sdk-chats')) return fixtureJSON(goalState === 'proposal' ? [chat,operator] : [chat]);
    if (method === 'GET' && url.pathname.endsWith('/api/sdk-projects')) return fixtureJSON([{id:'project-1',name:'Component library',path:'/home/demo/muxterm'}]);
    if (method === 'GET' && url.pathname.endsWith('/api/sdk-jobs')) return fixtureJSON([]);
    if (method === 'GET' && url.pathname.endsWith(`/api/sdk-chats/${id}/goal`)) {
      if (id.endsWith('-command-error')) return new Response('Goal unavailable',{status:503,headers:{'Content-Type':'text/plain'}});
      return fixtureJSON(goal);
    }
    if (method === 'GET' && url.pathname.endsWith('/api/sdk-goal-ledger')) return fixtureJSON(goalState === 'none' ? [] : [goal]);
    if (method === 'GET' && url.pathname.endsWith('/api/voice/settings')) return fixtureJSON({enabled:false,restartRequired:false});
    if (method === 'GET' && url.pathname.endsWith(`/api/sdk-chats/${id}/agents`)) return fixtureJSON(scenario === 'delegated' ? delegated.filter(event => event.type.startsWith('delegate.') || event.type.startsWith('tool.')) : []);
    if (url.pathname.endsWith(`/api/sdk-chats/${id}/settings`)) {
      if (method === 'GET') return fixtureJSON(settings);
      if (method === 'PATCH') return fixtureJSON({...settings,...JSON.parse(String(init?.body || '{}')) as Record<string,unknown>});
    }
    if (method === 'GET' && url.pathname.endsWith(`/api/sdk-chats/${id}/history`)) {
      if (id.endsWith('-history-error') || (id.endsWith('-history-recovery') && historyRequests++ < 2)) return fixtureJSON({error:'History unavailable'},503);
      return fixtureJSON({from:0,to:100,hasMore:false,events:url.searchParams.get('view') === 'messages' ? messages : events});
    }
    if (method === 'POST' && url.pathname.endsWith('/api/sdk-chat-attachments')) return fixtureJSON({id:'story-attachment',kind:'file'});
    if (method === 'POST' && url.pathname.endsWith(`/api/sdk-chats/${id}/interrupt`)) return fixtureJSON({ok:true});
    if (method === 'POST' && url.pathname.endsWith(`/api/sdk-chats/${id}`)) return fixtureJSON({ok:true});
    return fixtureJSON({error:`No chat fixture for ${method} ${url.pathname}`},501);
  };
}

interface ChatArgs { sessionId:string; compact:boolean }

const meta = {
  title:'Screens/Chat', tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true,apiFixture:chatFixture('storybook-chat-conversation')},
  args:{sessionId:'storybook-chat-conversation',compact:false},
  render:(args:ChatArgs) => html`<div style="position:relative;width:100%;height:100vh"><mux-sdk-chat .sessionId=${args.sessionId} .compact=${args.compact}></mux-sdk-chat></div>`,
  play:async () => { await sdkChats.refresh(); },
} satisfies Meta<ChatArgs>;
export default meta;
type Story = StoryObj<ChatArgs>;

export const Conversation: Story = {};
const showHistoryFailure = async ({canvasElement}:{canvasElement:HTMLElement}) => {
  await sdkChats.refresh();
  const chat = canvasElement.querySelector<MuxSDKChat>('mux-sdk-chat');
  if (chat) (chat as unknown as {reconnectFailures:number}).reconnectFailures = 6;
};
export const HistoryUnavailable: Story = {
  args:{sessionId:'storybook-chat-history-error'},
  parameters:{apiFixture:chatFixture('storybook-chat-history-error')},
  play:showHistoryFailure,
};
export const PhoneHistoryUnavailable: Story = {
  ...HistoryUnavailable,
  args:{sessionId:'storybook-chat-phone-history-error'},
  parameters:{apiFixture:chatFixture('storybook-chat-phone-history-error')},
  globals:{viewport:{value:'phone390',isRotated:false}},
};
export const HistoryRecovery: Story = {
  args:{sessionId:'storybook-chat-history-recovery'},
  parameters:{apiFixture:chatFixture('storybook-chat-history-recovery')},
  play:showHistoryFailure,
};
const inspectGoalCommand = async ({canvasElement}:{canvasElement:HTMLElement}) => {
  await sdkChats.refresh();
  const chat = canvasElement.querySelector<MuxSDKChat>('mux-sdk-chat');
  for (let attempt=0; attempt<40; attempt++) {
    const field = chat?.shadowRoot?.querySelector<HTMLTextAreaElement>('.composer-row textarea');
    if (field) {
      field.value = '/goal';
      field.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true}));
      await chat?.updateComplete;
      chat?.shadowRoot?.querySelector<HTMLElement>('mux-ui-button[accessible-label="Send message"]')?.click();
      return;
    }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('The chat command composer did not render');
};
export const GoalCommandNotice: Story = {
  args:{sessionId:'storybook-chat-command-notice'},
  parameters:{apiFixture:chatFixture('storybook-chat-command-notice')},
  play:inspectGoalCommand,
};
export const GoalCommandUnavailable: Story = {
  args:{sessionId:'storybook-chat-command-error'},
  parameters:{apiFixture:chatFixture('storybook-chat-command-error')},
  play:inspectGoalCommand,
};
export const PhoneGoalCommandUnavailable: Story = {
  ...GoalCommandUnavailable,
  args:{sessionId:'storybook-chat-phone-command-error'},
  parameters:{apiFixture:chatFixture('storybook-chat-phone-command-error')},
  globals:{viewport:{value:'phone390',isRotated:false}},
};
export const MessageEdit: Story = {
  args:{sessionId:'storybook-chat-message-edit'},
  parameters:{apiFixture:chatFixture('storybook-chat-message-edit')},
  play:async ({canvasElement}) => {
    await sdkChats.refresh();
    const chat = canvasElement.querySelector<MuxSDKChat>('mux-sdk-chat');
    for (let attempt = 0; attempt < 20; attempt++) {
      const edit = chat?.shadowRoot?.querySelector<HTMLElement>('mux-ui-button[accessible-label="Edit message in a new chat"]');
      if (edit) {
        edit.click();
        await chat?.updateComplete;
        await new Promise(resolve => setTimeout(resolve, 100));
        chat?.shadowRoot?.querySelector<HTMLElement>('.body')?.scrollTo({top:0});
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The message edit action did not render');
  },
};
export const WorkDetails: Story = {
  args:{sessionId:'storybook-chat-work'},
  parameters:{apiFixture:chatFixture('storybook-chat-work')},
  play:async ({canvasElement}) => {
    await sdkChats.refresh();
    const chat = canvasElement.querySelector<MuxSDKChat>('mux-sdk-chat');
    await chat?.updateComplete;
    const disclosures = chat?.shadowRoot?.querySelectorAll<HTMLDetailsElement>('.work-disclosure');
    disclosures?.item(1)?.querySelector('summary')?.click();
  },
};
export const DelegatedWork: Story = {
  args:{sessionId:'storybook-chat-delegated'},
  parameters:{apiFixture:chatFixture('storybook-chat-delegated','ready','none','delegated')},
};
export const PhoneDelegatedWork: Story = {
  args:{sessionId:'storybook-chat-phone-delegated'},
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:chatFixture('storybook-chat-phone-delegated','ready','none','delegated')},
};
export const DelegatedWorkOpen: Story = {
  args:{sessionId:'storybook-chat-delegated-open'},
  parameters:{apiFixture:chatFixture('storybook-chat-delegated-open','ready','none','delegated')},
  play:async ({canvasElement}) => {
    await sdkChats.refresh();
    const chat = canvasElement.querySelector<MuxSDKChat>('mux-sdk-chat');
    for (let attempt = 0; attempt < 20; attempt++) {
      const card = chat?.shadowRoot?.querySelector<HTMLElement>('mux-ui-action-tile.delegate-card');
      if (card) { card.click(); return; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The delegated work card did not render');
  },
};
export const LinkedReports: Story = {
  args:{sessionId:'storybook-chat-linked-reports'},
  parameters:{apiFixture:chatFixture('storybook-chat-linked-reports','ready','none','reports')},
};
export const PhoneLinkedReports: Story = {
  args:{sessionId:'storybook-chat-phone-linked-reports'},
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:chatFixture('storybook-chat-phone-linked-reports','ready','none','reports')},
};
export const FailedLinkedReport: Story = {
  args:{sessionId:'storybook-chat-failed-linked-report'},
  parameters:{apiFixture:chatFixture('storybook-chat-failed-linked-report','ready','none','failed-report')},
};
const showRunningTurn = async ({canvasElement}: {canvasElement:HTMLElement}) => {
  await sdkChats.refresh();
  const chat = canvasElement.querySelector<MuxSDKChat>('mux-sdk-chat');
  await chat?.updateComplete;
  if (chat) (chat as unknown as {busy:boolean}).busy = true;
};
export const RunningTurn: Story = {
  args:{sessionId:'storybook-chat-running'},
  parameters:{apiFixture:chatFixture('storybook-chat-running','working')},
  play:showRunningTurn,
};
export const PhoneRunningTurn: Story = {
  args:{sessionId:'storybook-chat-phone-running'},
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:chatFixture('storybook-chat-phone-running','working')},
  play:showRunningTurn,
};
export const DraftMessage: Story = {
  args:{sessionId:'storybook-chat-draft'},
  parameters:{apiFixture:chatFixture('storybook-chat-draft')},
  play:async ({canvasElement}) => {
    await sdkChats.refresh();
    const chat = canvasElement.querySelector<MuxSDKChat>('mux-sdk-chat');
    await chat?.updateComplete;
    const field = chat?.shadowRoot?.querySelector<HTMLTextAreaElement>('.composer-row textarea');
    if (field) {
      field.value = 'Please summarize the remaining design-system seams.';
      field.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true}));
    }
  },
};
export const PhoneDraftMessage: Story = {
  args:{sessionId:'storybook-chat-phone-draft'},
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:chatFixture('storybook-chat-phone-draft')},
  play:DraftMessage.play,
};
const showCommandSuggestions = async ({canvasElement}: {canvasElement: HTMLElement}) => {
  await sdkChats.refresh();
  const chat = canvasElement.querySelector<MuxSDKChat>('mux-sdk-chat');
  await chat?.updateComplete;
  const field = chat?.shadowRoot?.querySelector<HTMLTextAreaElement>('.composer-row textarea');
  if (field) {
    field.value = '/goal ';
    field.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true}));
    field.focus();
  }
};
export const CommandSuggestions: Story = {
  args:{sessionId:'storybook-chat-commands'},
  parameters:{apiFixture:chatFixture('storybook-chat-commands')},
  play:showCommandSuggestions,
};
export const PhoneCommandSuggestions: Story = {
  args:{sessionId:'storybook-chat-phone-commands'},
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:chatFixture('storybook-chat-phone-commands')},
  play:showCommandSuggestions,
};
const attachFile = async ({canvasElement}:{canvasElement:HTMLElement}, expectedState:'ready'|'error' = 'ready') => {
    await sdkChats.refresh();
    const chat = canvasElement.querySelector<MuxSDKChat>('mux-sdk-chat');
    await chat?.updateComplete;
    const input = chat?.shadowRoot?.querySelector<HTMLInputElement>('.file-input');
    if (input) {
      const files = new DataTransfer();
      files.items.add(new File(['Component review notes'], 'review-notes.txt', {type:'text/plain'}));
      input.files = files.files;
      input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    }
    for (let attempt=0; attempt<30; attempt++) {
      await chat?.updateComplete;
      if (chat?.shadowRoot?.querySelector('mux-ui-attachment')?.getAttribute('state') === expectedState) return;
      await new Promise(resolve => setTimeout(resolve,50));
    }
    throw new Error(`Attachment did not reach ${expectedState}`);
};
const failedAttachmentFixture = (id:string):ApiFixture => {
  const fixture = chatFixture(id);
  return request => request.method === 'POST' && request.url.pathname.endsWith('/api/sdk-chat-attachments')
    ? fixtureJSON({reason:'The file could not be uploaded. Try attaching it again.'},413)
    : fixture(request);
};
export const FileAttached: Story = {
  args:{sessionId:'storybook-chat-attachment'},
  parameters:{apiFixture:chatFixture('storybook-chat-attachment')},
  play:attachFile,
};
export const PhoneFileAttached: Story = {
  args:{sessionId:'storybook-chat-phone-attachment'},
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:chatFixture('storybook-chat-phone-attachment')},
  play:FileAttached.play,
};
export const FileUploadFailed: Story = {
  args:{sessionId:'storybook-chat-attachment-error'},
  parameters:{apiFixture:failedAttachmentFixture('storybook-chat-attachment-error')},
  play:context => attachFile(context,'error'),
};
const showVoiceSpeaking = async ({canvasElement}: {canvasElement:HTMLElement}) => {
  await sdkChats.refresh();
  const chat = canvasElement.querySelector<MuxSDKChat>('mux-sdk-chat');
  await chat?.updateComplete;
  if (chat) (chat as unknown as {voiceState:'speaking'}).voiceState = 'speaking';
};
export const VoiceSpeaking: Story = {
  args:{sessionId:'storybook-chat-speaking'},
  parameters:{apiFixture:chatFixture('storybook-chat-speaking')},
  play:showVoiceSpeaking,
};
export const PhoneVoiceSpeaking: Story = {
  args:{sessionId:'storybook-chat-phone-speaking'},
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:chatFixture('storybook-chat-phone-speaking')},
  play:showVoiceSpeaking,
};
export const RecoveryRequired: Story = {
  args:{sessionId:'storybook-chat-recovery'},
  parameters:{apiFixture:chatFixture('storybook-chat-recovery','uncertain')},
};
export const PhoneRecoveryRequired: Story = {
  args:{sessionId:'storybook-chat-phone-recovery'},
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:chatFixture('storybook-chat-phone-recovery','uncertain')},
};
export const LightRecoveryRequired: Story = {
  args:{sessionId:'storybook-chat-light-recovery'},
  globals:{palette:'github-light'},
  parameters:{apiFixture:chatFixture('storybook-chat-light-recovery','uncertain')},
};
export const PhoneConversation: Story = {
  args:{sessionId:'storybook-chat-phone'},
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:chatFixture('storybook-chat-phone')},
};
export const EmbeddedPhoneChat: Story = {
  args:{sessionId:'storybook-chat-embedded-phone',compact:true},
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:chatFixture('storybook-chat-embedded-phone')},
  render:(args:ChatArgs) => html`<div style="display:flex;flex-direction:column;height:100dvh;background:var(--ui-surface-base)">
    <mux-title-bar .chatTitle=${'Component library review'}></mux-title-bar>
    <div style="position:relative;flex:1;min-height:0"><mux-sdk-chat .sessionId=${args.sessionId} .compact=${args.compact}></mux-sdk-chat></div>
  </div>`,
};
const openLedger = async ({canvasElement}: {canvasElement: HTMLElement}) => {
  await sdkChats.refresh();
  const chat = canvasElement.querySelector<MuxSDKChat>('mux-sdk-chat');
  await chat?.updateComplete;
  chat?.shadowRoot?.querySelector<HTMLElement>('mux-ui-button[accessible-label="Open goal ledger"]')?.click();
};
export const GoalLedger: Story = {
  args:{sessionId:'storybook-chat-goal'},
  parameters:{apiFixture:chatFixture('storybook-chat-goal','ready','active')},
  play:openLedger,
};
export const GoalPendingProposal: Story = {
  args:{sessionId:'storybook-chat-proposal'},
  parameters:{apiFixture:chatFixture('storybook-chat-proposal','ready','proposal')},
  play:openLedger,
};
export const PhoneGoalEditor: Story = {
  args:{sessionId:'storybook-chat-phone-goal'},
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:chatFixture('storybook-chat-phone-goal','ready','active')},
  play:async (context) => {
    await openLedger(context);
    const chat = context.canvasElement.querySelector<MuxSDKChat>('mux-sdk-chat');
    await chat?.updateComplete;
    chat?.shadowRoot?.querySelector<HTMLElement>('.goal-edit-action')?.click();
  },
};
