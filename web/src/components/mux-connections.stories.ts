import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import type { MuxConnections } from './mux-connections.js';
import './mux-connections.js';

// The groups match the current server catalog. An incorrect group hides the
// associated detail view rather than merely changing a label.
const catalog = [
  { id:'github', name:'GitHub', group:'Developer', description:'Repositories, issues, and pull requests', docsUrl:'https://github.com/github/github-mcp-server/releases', availability:'local-setup' },
  { id:'onedrive', name:'OneDrive', group:'Microsoft personal', description:'Files from your personal Microsoft account', docsUrl:'https://github.com/Softeria/ms-365-mcp-server', availability:'local-setup' },
  { id:'outlook-mail', name:'Outlook Mail', group:'Microsoft personal', description:'Messages from your personal Microsoft account', docsUrl:'https://github.com/Softeria/ms-365-mcp-server', availability:'local-setup' },
  { id:'outlook-calendar', name:'Outlook Calendar', group:'Microsoft personal', description:'Events from your personal Microsoft account', docsUrl:'https://github.com/Softeria/ms-365-mcp-server', availability:'local-setup' },
  { id:'gmail', name:'Gmail', group:'Google Workspace', description:'Messages and drafts', docsUrl:'https://developers.google.com/workspace/guides/configure-mcp-servers', endpoint:'https://example.test/mcp', availability:'developer-preview', scopes:['gmail.readonly'], readTools:['search_mail'] },
  { id:'google-drive', name:'Google Drive', group:'Google Workspace', description:'Files and search', docsUrl:'https://developers.google.com/workspace/guides/configure-mcp-servers', endpoint:'https://example.test/drive', availability:'developer-preview', scopes:['drive.readonly'], readTools:['search_files'] },
  { id:'google-calendar', name:'Google Calendar', group:'Google Workspace', description:'Events and availability', docsUrl:'https://developers.google.com/workspace/guides/configure-mcp-servers', endpoint:'https://example.test/calendar', availability:'developer-preview', scopes:['calendar.readonly'], readTools:['list_events'] },
  { id:'google-docs', name:'Google Docs', group:'Google Workspace', description:'Documents', docsUrl:'https://developers.google.com/workspace/guides/configure-mcp-servers', endpoint:'https://example.test/docs', availability:'developer-preview', scopes:['documents.readonly'], readTools:['read_document'] },
  { id:'google-sheets', name:'Google Sheets', group:'Google Workspace', description:'Spreadsheets', docsUrl:'https://developers.google.com/workspace/guides/configure-mcp-servers', endpoint:'https://example.test/sheets', availability:'developer-preview', scopes:['spreadsheets.readonly'], readTools:['read_sheet'] },
  { id:'google-slides', name:'Google Slides', group:'Google Workspace', description:'Presentations', docsUrl:'https://developers.google.com/workspace/guides/configure-mcp-servers', endpoint:'https://example.test/slides', availability:'developer-preview', scopes:['presentations.readonly'], readTools:['read_presentation'] },
];

const githubSetup = { state:'setup-required', enabled:false, ghInstalled:false, serverInstalled:false, signedIn:false, toolCount:0, error:'', installing:false, loginState:'', loginCode:'', loginError:'' };
const microsoftDisconnected = { state:'disconnected', loginState:'', userCode:'', verificationUrl:'', error:'', toolCount:0 };
type Scenario = { github?:Record<string,unknown>; microsoft?:Record<string,unknown>; error?:boolean; legacyAuthorization?:boolean };
function fixtureFor(scenario:Scenario = {}):ApiFixture {
  return ({url,method}) => {
    if (method!=='GET') return fixtureJSON({error:'Use dev-local to exercise account actions.'},501);
    if (scenario.error && url.pathname.endsWith('/api/connections')) return fixtureJSON({error:'Connection status could not be loaded.'},503);
    if (url.pathname.endsWith('/api/connections')) return fixtureJSON({catalog,github:{...githubSetup,...scenario.github}});
    if (url.pathname.endsWith('/api/connections/remote')) return fixtureJSON({callbackUrl:'https://muxterm.example.test/api/connections/remote/callback',items:[]});
    if (url.pathname.endsWith('/api/connections/microsoft')) return fixtureJSON({personal:{...microsoftDisconnected,...scenario.microsoft}});
    if (url.pathname.endsWith('/api/connections/workiq')) return fixtureJSON({savedAuthorization:scenario.legacyAuthorization??false});
    return fixtureJSON({error:`No story fixture for ${url.pathname}`},404);
  };
}

const meta = {
  title:'Screens/Connections',tags:['autodocs'],
  parameters:{layout:'fullscreen',apiFixture:fixtureFor()},
  render:(args:{selection:string})=>html`<mux-connections .initialSelection=${args.selection}></mux-connections>`,
  args:{selection:'github'},
  argTypes:{selection:{control:'select',options:['github','microsoft','google']}},
} satisfies Meta<{selection:string}>;
export default meta;
type Story = StoryObj<{selection:string}>;

export const GitHubSetup:Story = {};
export const GitHubReady:Story = {parameters:{apiFixture:fixtureFor({github:{state:'ready',enabled:true,ghInstalled:true,serverInstalled:true,signedIn:true,toolCount:14}})}};
export const GitHubDeviceCode:Story = {parameters:{apiFixture:fixtureFor({github:{state:'setup-required',loginState:'pending',loginCode:'ABCD-EFGH'}})}};
export const MicrosoftDisconnected:Story = {args:{selection:'microsoft'}};
export const MicrosoftPending:Story = {args:{selection:'microsoft'},parameters:{apiFixture:fixtureFor({microsoft:{state:'pending',loginState:'pending',userCode:'WXYZ-1234',verificationUrl:'https://microsoft.com/devicelogin'}})}};
export const MicrosoftReady:Story = {args:{selection:'microsoft'},parameters:{apiFixture:fixtureFor({microsoft:{state:'ready',toolCount:12}})}};
export const MicrosoftNeedsAttention:Story = {args:{selection:'microsoft'},parameters:{apiFixture:fixtureFor({microsoft:{state:'needs-attention',error:'Sign in again to refresh access.'}})}};
export const GooglePreview:Story = {args:{selection:'google'}};
export const GoogleManualEntry:Story = {args:{selection:'google'},play:async ({canvasElement})=>{
  const screen=canvasElement.querySelector<MuxConnections>('mux-connections');
  for(let attempt=0;attempt<80;attempt++){
    await screen?.updateComplete;
    const summary=screen?.shadowRoot?.querySelector<HTMLElement>('details.box summary');
    if(summary){summary.click();return;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error('Google manual setup did not render');
}};
export const LoadError:Story = {parameters:{apiFixture:fixtureFor({error:true})}};
export const PhoneGoogle:Story = {args:{selection:'google'},globals:{viewport:{value:'phone390',isRotated:false}}};
export const PhoneMicrosoftReady:Story = {args:{selection:'microsoft'},globals:{viewport:{value:'phone390',isRotated:false}},parameters:{apiFixture:fixtureFor({microsoft:{state:'ready',toolCount:12}})}};
