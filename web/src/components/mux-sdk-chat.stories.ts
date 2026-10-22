import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import { sdkChats, type SDKChat } from '../lib/sdk-chats.js';
import type { MuxSDKChat } from './mux-sdk-chat.js';
import './mux-sdk-chat.js';

type ChatEvent = {
  at:string; type:string; text?:string; kind?:string; source?:string;
  inputId?:string; inputIds?:string[]; itemId?:string; complete?:boolean;
  toolId?:string; name?:string; raw?:unknown; summary?:boolean;
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

const settings = {
  model:'gpt-6-sol', effort:'medium', permission:'full-permission', mode:'agent',
  permissions:['read-only','workspace-write','full-permission'], modes:['agent','plan'],
  models:[
    {id:'gpt-6-astra',label:'GPT-6-Astra',efforts:['low','medium','high'],defaultEffort:'medium'},
    {id:'gpt-6-sol',label:'GPT-6-Sol',efforts:['low','medium','high'],defaultEffort:'medium'},
  ],
};

function chatFixture(id:string, state:'ready'|'working'|'uncertain' = 'ready'): ApiFixture {
  const chat: SDKChat = {
    id, title:'Component library review', workspaceId:'project-1',
    projectPath:'/home/demo/muxterm', harness:'codex', state,
    createdAt:'2026-10-22T10:00:00Z',
  };
  const events = state === 'working' ? running : transcript;
  const messages = events.filter(event => event.type !== 'tool.started' && event.type !== 'tool.completed');
  return ({url,method,init}) => {
    if (method === 'GET' && url.pathname.endsWith('/api/sdk-chats')) return fixtureJSON([chat]);
    if (method === 'GET' && url.pathname.endsWith('/api/sdk-projects')) return fixtureJSON([{id:'project-1',name:'Component library',path:'/home/demo/muxterm'}]);
    if (method === 'GET' && url.pathname.endsWith('/api/sdk-jobs')) return fixtureJSON([]);
    if (method === 'GET' && url.pathname.endsWith('/api/voice/settings')) return fixtureJSON({enabled:false,restartRequired:false});
    if (method === 'GET' && url.pathname.endsWith(`/api/sdk-chats/${id}/agents`)) return fixtureJSON([]);
    if (url.pathname.endsWith(`/api/sdk-chats/${id}/settings`)) {
      if (method === 'GET') return fixtureJSON(settings);
      if (method === 'PATCH') return fixtureJSON({...settings,...JSON.parse(String(init?.body || '{}')) as Record<string,unknown>});
    }
    if (method === 'GET' && url.pathname.endsWith(`/api/sdk-chats/${id}/history`)) {
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
export const RunningTurn: Story = {
  args:{sessionId:'storybook-chat-running'},
  parameters:{apiFixture:chatFixture('storybook-chat-running','working')},
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
export const FileAttached: Story = {
  args:{sessionId:'storybook-chat-attachment'},
  parameters:{apiFixture:chatFixture('storybook-chat-attachment')},
  play:async ({canvasElement}) => {
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
  },
};
export const RecoveryRequired: Story = {
  args:{sessionId:'storybook-chat-recovery'},
  parameters:{apiFixture:chatFixture('storybook-chat-recovery','uncertain')},
};
export const PhoneConversation: Story = {
  args:{sessionId:'storybook-chat-phone'},
  globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:chatFixture('storybook-chat-phone')},
};
