import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import type { MuxSDKUtility } from './mux-sdk-utility.js';
import type { MuxMeetings } from './mux-meetings.js';
import type { MuxUIButton } from '../ui/button.js';
import './mux-sdk-utility.js';

const root = '/home/demo/muxterm';
const sessionId = (name: string) => `storybook-utility-${name}`;
const listing = (path: string) => fixtureJSON({
  root, path, truncated: false,
  entries: path === '.' ? [
    { name:'docs', dir:true, size:0, modified:1761120000 },
    { name:'src', dir:true, size:0, modified:1761120000 },
    { name:'README.md', dir:false, size:1268, modified:1761120000 },
    { name:'preview.html', dir:false, size:131, modified:1761120000 },
    { name:'package.json', dir:false, size:489, modified:1761120000 },
  ] : path === 'docs' ? [
    { name:'design-system.md', dir:false, size:608, modified:1761120000 },
  ] : path === 'src' ? [
    { name:'app.ts', dir:false, size:716, modified:1761120000 },
  ] : [],
});

const artifacts: Record<string, {kind:'markdown'|'text'; text:string; contentType?:string}> = {
  'README.md': {kind:'markdown',text:'# Muxterm component library\n\nA shared visual language for the terminal, chat, and project tools.\n\n## Review checklist\n\n- Browse every component in Storybook\n- Inspect the phone layout\n- Use semantic tokens for color and spacing'},
  'docs/design-system.md': {kind:'markdown',text:'# Design system\n\nUse the shared Button, Feedback, Dialog, and navigation components.\n\n**Themes** provide semantic surfaces, borders, text, accent, and focus.'},
  'src/app.ts': {kind:'text',text:'export class MuxApp {\n  render() {\n    return "Component library";\n  }\n}\n'},
  'preview.html': {kind:'text',contentType:'text/html',text:'<main id="result">Preview ready</main><script>document.querySelector("#result").textContent="Interactive preview running";</script>'},
  'package.json': {kind:'text',text:'{"name":"muxterm-demo","scripts":{"storybook":"storybook dev"}}'},
};

function utilityFixture(id: string, emptyPages = false): ApiFixture {
  let fileRequests = 0;
  let rawRequests = 0;
  let treeRequests = 0;
  let changesRequests = 0;
  let diffRequests = 0;
  let pagesRequests = 0;
  return ({url,method}) => {
    const base = `/api/sdk-chats/${id}/utility/`;
    if (method === 'GET' && url.pathname === '/api/sdk-chats') return fixtureJSON([]);
    if (method === 'GET' && url.pathname === `/api/sdk-chats/${id}/operator`) return fixtureJSON({
      operator:{id,title:'Component library review',harness:'codex',state:'ready',operator:true,operatorLanes:[],workspaceId:'project-1',projectPath:root},lanes:[],
    });
    if (method === 'GET' && url.pathname === `${base}files`) {
      if (id.endsWith('-tree-error') || (id.endsWith('-tree-recovery') && treeRequests++ === 0)) return fixtureJSON({error:'Folder unavailable'},503);
      return listing(url.searchParams.get('path') || '.');
    }
    if (method === 'GET' && url.pathname === `${base}file`) {
      const path = url.searchParams.get('path') || '';
      if (id.endsWith('-file-error') || (id.endsWith('-file-recovery') && fileRequests++ === 0)) return fixtureJSON({error:'File unavailable'},503);
      const artifact = artifacts[path];
      if (!artifact) return fixtureJSON({error:'File not found'},404);
      return fixtureJSON({path,name:path.split('/').pop(),size:artifact.text.length,modified:1761120000,kind:artifact.kind,contentType:artifact.contentType || (artifact.kind === 'markdown' ? 'text/markdown' : 'text/plain'),text:artifact.text,tooLarge:id.endsWith('-file-large'),maxBytes:2097152,binary:false});
    }
    if (method === 'GET' && url.pathname === `${base}raw`) {
      if (id.endsWith('-raw-error') || (id.endsWith('-raw-recovery') && rawRequests++ === 0)) return fixtureJSON({error:'Preview unavailable'},503);
      const artifact = artifacts[url.searchParams.get('path') || ''];
      return artifact ? new Response(artifact.text,{headers:{'Content-Type':artifact.contentType || 'text/plain'}}) : fixtureJSON({error:'File not found'},404);
    }
    if (method === 'GET' && url.pathname === `${base}search`) {
      if (id.endsWith('-search-error')) return fixtureJSON({error:'Search unavailable'},503);
      const query = (url.searchParams.get('q') || '').toLowerCase();
      return fixtureJSON({results:Object.keys(artifacts).filter(path => path.toLowerCase().includes(query)).map(path => ({path,name:path.split('/').pop(),size:artifacts[path].text.length})),truncated:false});
    }
    if (method === 'GET' && url.pathname === `${base}changes`) {
      if (id.endsWith('-changes-error') || (id.endsWith('-changes-recovery') && changesRequests++ === 0)) return fixtureJSON({error:'Changes unavailable'},503);
      return fixtureJSON({repos:[{root,name:'muxterm',branch:'design-system'}],changes:[{repo:root,path:'README.md',status:' M'},{repo:root,path:'src/app.ts',status:' M'}],truncated:false});
    }
    if (method === 'GET' && url.pathname === `${base}change`) {
      if (id.endsWith('-diff-error') || (id.endsWith('-diff-recovery') && diffRequests++ === 0)) return fixtureJSON({error:'Diff unavailable'},503);
      return fixtureJSON({repo:root,path:url.searchParams.get('path'),before:'# Muxterm\n',after:'# Muxterm component library\n',binary:false,tooLarge:false});
    }
    if (method === 'GET' && url.pathname === `${base}pages`) {
      if (id.endsWith('-pages-error') || (id.endsWith('-pages-recovery') && pagesRequests++ === 0)) return fixtureJSON({error:'Pages unavailable'},503);
      return fixtureJSON({version:1,pages:emptyPages ? [] : [
      {id:'review-page',title:id.endsWith('-subpage') ? 'Document actions review' : 'Component review',blocks:[],content:[{type:'paragraph',content:'Review the shared controls and phone layout.'}]},
      ...(id.endsWith('-subpage') ? [{id:'child-page',parentId:'review-page',title:'Phone child review of document actions',blocks:[],content:[{type:'paragraph',content:'Check the page breadcrumb.'}]}] : []),
      ]});
    }
    if (method === 'PUT' && url.pathname === `${base}pages`) return fixtureJSON({version:2});
    if (method === 'GET' && url.pathname === `/api/sdk-chats/${id}/meetings`) return fixtureJSON([]);
    return fixtureJSON({error:`No utility fixture for ${method} ${url.pathname}`},501);
  };
}

interface UtilityArgs { sessionId:string; goalText:string; goalState:string; goalHumanPaused:boolean }
const meta = {
  title:'Screens/Utility', tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true,apiFixture:utilityFixture(sessionId('files'))},
  args:{sessionId:sessionId('files'),goalText:'',goalState:'',goalHumanPaused:false},
  render:(args:UtilityArgs) => html`<div style="width:100%;height:100vh"><mux-sdk-utility .sessionId=${args.sessionId} .projectPath=${root} .goalText=${args.goalText} .goalState=${args.goalState} .goalHumanPaused=${args.goalHumanPaused} .touched=${['docs/design-system.md']}></mux-sdk-utility></div>`,
} satisfies Meta<UtilityArgs>;
export default meta;
type Story = StoryObj<UtilityArgs>;

function target(canvasElement: HTMLElement): MuxSDKUtility | null { return canvasElement.querySelector('mux-sdk-utility'); }

export const Files: Story = {};
export const Goal: Story = {
  args:{sessionId:sessionId('goal'),goalState:'active',goalText:'# Goal\n\nCatalog every shared control, then stop after browser review.\n\n- Check the chat and utility layouts.\n- Record any remaining gaps.'},
  parameters:{apiFixture:utilityFixture(sessionId('goal'))},
  play:async ({canvasElement}) => { target(canvasElement)?.showPanel('goal'); },
};
export const GoalPaused: Story = {
  ...Goal,
  args:{...Goal.args,sessionId:sessionId('goal-paused'),goalState:'paused',goalHumanPaused:true},
  parameters:{apiFixture:utilityFixture(sessionId('goal-paused'))},
};
export const GoalAchieved: Story = {
  ...Goal,
  args:{...Goal.args,sessionId:sessionId('goal-achieved'),goalState:'achieved'},
  parameters:{apiFixture:utilityFixture(sessionId('goal-achieved'))},
};
export const FileTreeUnavailable: Story = {
  args:{sessionId:sessionId('tree-error')},parameters:{apiFixture:utilityFixture(sessionId('tree-error'))},
};
export const FileTreeRecovery: Story = {
  args:{sessionId:sessionId('tree-recovery')},parameters:{apiFixture:utilityFixture(sessionId('tree-recovery'))},
};
export const FilePreview: Story = {
  args:{sessionId:sessionId('preview')},parameters:{apiFixture:utilityFixture(sessionId('preview'))},
  play:async ({canvasElement}) => { await target(canvasElement)?.showFile('README.md'); },
};
export const FileUnavailable: Story = {
  args:{sessionId:sessionId('file-error')},parameters:{apiFixture:utilityFixture(sessionId('file-error'))},
  play:async ({canvasElement}) => { await target(canvasElement)?.showFile('README.md'); },
};
export const FileRecovery: Story = {
  args:{sessionId:sessionId('file-recovery')},parameters:{apiFixture:utilityFixture(sessionId('file-recovery'))},
  play:FileUnavailable.play,
};
export const FileTooLarge: Story = {
  args:{sessionId:sessionId('file-large')},parameters:{apiFixture:utilityFixture(sessionId('file-large'))},
  play:async ({canvasElement}) => { await target(canvasElement)?.showFile('README.md'); },
};
export const PhoneFileUnavailable: Story = {
  args:{sessionId:sessionId('phone-file-error')},parameters:{apiFixture:utilityFixture(sessionId('phone-file-error'))},
  globals:{viewport:{value:'phone390',isRotated:false}},play:FileUnavailable.play,
};
export const HTMLPreviewUnavailable: Story = {
  args:{sessionId:sessionId('raw-error')},parameters:{apiFixture:utilityFixture(sessionId('raw-error'))},
  play:async ({canvasElement}) => { await target(canvasElement)?.showFile('preview.html'); },
};
export const HTMLPreviewRecovery: Story = {
  args:{sessionId:sessionId('raw-recovery')},parameters:{apiFixture:utilityFixture(sessionId('raw-recovery'))},
  play:HTMLPreviewUnavailable.play,
};
export const HTMLPreview: Story = {
  args:{sessionId:sessionId('html-preview')},parameters:{apiFixture:utilityFixture(sessionId('html-preview'))},
  play:async ({canvasElement}) => { await target(canvasElement)?.showFile('preview.html'); },
};
export const PhoneHTMLPreview: Story = {
  args:{sessionId:sessionId('phone-html-preview')},parameters:{apiFixture:utilityFixture(sessionId('phone-html-preview'))},
  globals:{viewport:{value:'phone390',isRotated:false}},play:HTMLPreview.play,
};
export const NestedFilePreview: Story = {
  args:{sessionId:sessionId('nested-preview')},parameters:{apiFixture:utilityFixture(sessionId('nested-preview'))},
  play:async ({canvasElement}) => { await target(canvasElement)?.showFile('docs/design-system.md'); },
};
export const PhoneNestedFilePreview: Story = {
  args:{sessionId:sessionId('phone-nested-preview')},parameters:{apiFixture:utilityFixture(sessionId('phone-nested-preview'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:NestedFilePreview.play,
};
export const HiddenFileBrowser: Story = {
  args:{sessionId:sessionId('hidden-browser')},parameters:{apiFixture:utilityFixture(sessionId('hidden-browser'))},
  play:async ({canvasElement}) => {
    const utility = target(canvasElement);
    await utility?.showFile('docs/design-system.md');
    utility?.querySelector<MuxUIButton>('mux-ui-button[accessible-label="Hide file browser"]')?.click();
  },
};
export const FileOpenActions: Story = {
  args:{sessionId:sessionId('file-actions')},parameters:{apiFixture:utilityFixture(sessionId('file-actions'))},
  play:async ({canvasElement}) => {
    const utility = target(canvasElement);
    await utility?.showFile('README.md');
    utility?.querySelector<MuxUIButton>('.file-open-button')?.click();
  },
};
export const PhoneFileOpenActions: Story = {
  args:{sessionId:sessionId('phone-file-actions')},parameters:{apiFixture:utilityFixture(sessionId('phone-file-actions'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:FileOpenActions.play,
};
export const QuickOpen: Story = {
  args:{sessionId:sessionId('quick-open')},parameters:{apiFixture:utilityFixture(sessionId('quick-open'))},
  play:async ({canvasElement}) => {
    const utility = target(canvasElement);
    await utility?.updateComplete;
    utility?.querySelector<MuxUIButton>('mux-ui-button[accessible-label="Quick open file"]')?.click();
  },
};
export const PhoneQuickOpen: Story = {
  args:{sessionId:sessionId('phone-quick-open')},parameters:{apiFixture:utilityFixture(sessionId('phone-quick-open'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:QuickOpen.play,
};
const typeQuickOpen = async (canvasElement: HTMLElement, query: string) => {
  const utility = target(canvasElement);
  await utility?.updateComplete;
  utility?.querySelector<MuxUIButton>('mux-ui-button[accessible-label="Quick open file"]')?.click();
  await utility?.updateComplete;
  const input = utility?.querySelector('mux-ui-command-search')?.shadowRoot?.querySelector<HTMLInputElement>('input');
  if (input) { input.value = query; input.dispatchEvent(new InputEvent('input', { bubbles:true, composed:true })); }
};
export const QuickOpenResults: Story = {
  args:{sessionId:sessionId('quick-open-results')},parameters:{apiFixture:utilityFixture(sessionId('quick-open-results'))},
  play:async ({canvasElement}) => typeQuickOpen(canvasElement,'md'),
};
export const PhoneQuickOpenResults: Story = {
  args:{sessionId:sessionId('phone-quick-open-results')},parameters:{apiFixture:utilityFixture(sessionId('phone-quick-open-results'))},
  globals:{viewport:{value:'phone390',isRotated:false}}, play:QuickOpenResults.play,
};
export const QuickOpenNoResults: Story = {
  args:{sessionId:sessionId('quick-open-empty')},parameters:{apiFixture:utilityFixture(sessionId('quick-open-empty'))},
  play:async ({canvasElement}) => typeQuickOpen(canvasElement,'nothing-matches'),
};
export const QuickOpenError: Story = {
  args:{sessionId:sessionId('quick-open-search-error')},parameters:{apiFixture:utilityFixture(sessionId('quick-open-search-error'))},
  play:async ({canvasElement}) => typeQuickOpen(canvasElement,'readme'),
};
export const Changes: Story = {
  args:{sessionId:sessionId('changes')},parameters:{apiFixture:utilityFixture(sessionId('changes'))},
  play:async ({canvasElement}) => { target(canvasElement)?.showPanel('changes'); },
};
export const ChangesUnavailable: Story = {
  args:{sessionId:sessionId('changes-error')},parameters:{apiFixture:utilityFixture(sessionId('changes-error'))},
  play:Changes.play,
};
export const ChangesRecovery: Story = {
  args:{sessionId:sessionId('changes-recovery')},parameters:{apiFixture:utilityFixture(sessionId('changes-recovery'))},
  play:Changes.play,
};
const openFirstChange = async (canvasElement: HTMLElement) => {
  const utility = target(canvasElement);
  utility?.showPanel('changes');
  let row: HTMLElement | null = null;
  for (let attempt=0; attempt<40 && !row; attempt++) {
    row = utility?.querySelector<HTMLElement>('.changes-list mux-ui-rail-row') || null;
    if (!row) await new Promise(resolve=>window.setTimeout(resolve,50));
  }
  row?.click();
};
export const DiffUnavailable: Story = {
  args:{sessionId:sessionId('diff-error')},parameters:{apiFixture:utilityFixture(sessionId('diff-error'))},
  play:async ({canvasElement}) => openFirstChange(canvasElement),
};
export const DiffRecovery: Story = {
  args:{sessionId:sessionId('diff-recovery')},parameters:{apiFixture:utilityFixture(sessionId('diff-recovery'))},
  play:DiffUnavailable.play,
};
export const NotesLibrary: Story = {
  args:{sessionId:sessionId('pages')},parameters:{apiFixture:utilityFixture(sessionId('pages'))},
  play:async ({canvasElement}) => { target(canvasElement)?.showPanel('pages'); },
};
export const NoteEditor: Story = {
  args:{sessionId:sessionId('note-editor')},parameters:{apiFixture:utilityFixture(sessionId('note-editor'))},
  play:async ({canvasElement}) => {
    target(canvasElement)?.showPanel('pages');
    let row: HTMLElement | null = null;
    for (let attempt=0; attempt<40 && !row; attempt++) {
      row = target(canvasElement)?.querySelector<HTMLElement>('mux-ui-rail-row[label="Component review"]') || null;
      if (!row) await new Promise(resolve=>window.setTimeout(resolve,50));
    }
    row?.click();
  },
};
export const NotesUnavailable: Story = {
  args:{sessionId:sessionId('pages-error')},parameters:{apiFixture:utilityFixture(sessionId('pages-error'))},
  play:NotesLibrary.play,
};
export const NotesRecovery: Story = {
  args:{sessionId:sessionId('pages-recovery')},parameters:{apiFixture:utilityFixture(sessionId('pages-recovery'))},
  play:NotesLibrary.play,
};
export const EmptyNotes: Story = {
  args:{sessionId:sessionId('empty-pages')},parameters:{apiFixture:utilityFixture(sessionId('empty-pages'),true)},
  play:async ({canvasElement}) => { target(canvasElement)?.showPanel('pages'); },
};
export const Status: Story = {
  args:{sessionId:sessionId('status')},parameters:{apiFixture:utilityFixture(sessionId('status'))},
  play:async ({canvasElement}) => { target(canvasElement)?.showPanel('status'); },
};
export const NewTab: Story = {
  args:{sessionId:sessionId('new')},parameters:{apiFixture:utilityFixture(sessionId('new'))},
  play:async ({canvasElement}) => { target(canvasElement)?.querySelector('mux-ui-tab-strip')?.shadowRoot?.querySelector<HTMLButtonElement>('button.add')?.click(); },
};
export const PhoneNewTab: Story = {
  args:{sessionId:sessionId('phone-new')},parameters:{apiFixture:utilityFixture(sessionId('phone-new'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:NewTab.play,
};
export const PhoneFiles: Story = {
  args:{sessionId:sessionId('phone')},parameters:{apiFixture:utilityFixture(sessionId('phone'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:async ({canvasElement}) => { await target(canvasElement)?.showFile('README.md'); },
};
export const PhoneChanges: Story = {
  args:{sessionId:sessionId('phone-changes')},parameters:{apiFixture:utilityFixture(sessionId('phone-changes'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:async ({canvasElement}) => { target(canvasElement)?.showPanel('changes'); },
};
export const PhoneNotes: Story = {
  args:{sessionId:sessionId('phone-pages')},parameters:{apiFixture:utilityFixture(sessionId('phone-pages'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:async ({canvasElement}) => { target(canvasElement)?.showPanel('pages'); },
};
export const PhoneSubpage: Story = {
  args:{sessionId:sessionId('phone-subpage')},parameters:{apiFixture:utilityFixture(sessionId('phone-subpage'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:async ({canvasElement}) => {
    target(canvasElement)?.showPanel('pages');
    let row: HTMLElement | null = null;
    for (let attempt=0; attempt<40 && !row; attempt++) {
      row = target(canvasElement)?.querySelector<HTMLElement>('mux-ui-rail-row[label="Phone child review of document actions"]') || null;
      if (!row) await new Promise(resolve=>window.setTimeout(resolve,50));
    }
    row?.click();
  },
};
export const PhonePageDeleteConfirmation: Story = {
  args:{sessionId:sessionId('phone-page-delete')},parameters:{apiFixture:utilityFixture(sessionId('phone-page-delete'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:async ({canvasElement}) => {
    target(canvasElement)?.showPanel('pages');
    let button: MuxUIButton | null = null;
    for (let attempt=0; attempt<40 && !button; attempt++) {
      button = target(canvasElement)?.querySelector<MuxUIButton>('mux-ui-button[accessible-label="Delete note Component review"]') || null;
      if (!button) await new Promise(resolve=>window.setTimeout(resolve,50));
    }
    button?.click();
  },
};
export const LightFilePreview: Story = {
  args:{sessionId:sessionId('light')},parameters:{apiFixture:utilityFixture(sessionId('light'))},
  globals:{palette:'github-light'},
  play:async ({canvasElement}) => { await target(canvasElement)?.showFile('README.md'); },
};

type MeetingScene = Parameters<MuxMeetings['showSample']>[0];
function meetingStory(name:string,scene:MeetingScene,phone=false):Story {
  const id=sessionId(`meeting-${name}`);
  return {
    args:{sessionId:id},parameters:{apiFixture:utilityFixture(id)},
    ...(phone ? {globals:{viewport:{value:'phone390',isRotated:false}}} : {}),
    play:async ({canvasElement}) => {
      const utility=target(canvasElement);
      utility?.showPanel('meetings');
      await utility?.updateComplete;
      utility?.querySelector<MuxMeetings>('mux-meetings')?.showSample(scene);
    },
  };
}

/** Production utility and meeting components, with sample data marked in the rail. */
export const MeetingLibrary:Story=meetingStory('library','library');
export const MeetingReview:Story=meetingStory('review','review');
export const MeetingRecorder:Story=meetingStory('recorder','recorder');
export const MeetingCallPreflight:Story=meetingStory('preflight','preflight');
export const MeetingWaiting:Story=meetingStory('waiting','waiting');
export const MeetingVideoCall:Story=meetingStory('video-call','call');
export const MeetingDirectRoute:Story=meetingStory('direct-route','call');
export const MeetingRelayRoute:Story=meetingStory('relay-route','relay');
export const MeetingConnectionStalled:Story=meetingStory('connection-stalled','stalled');
export const MeetingConnectionFailed:Story=meetingStory('connection-failed','failed');
export const MeetingScreenShare:Story=meetingStory('screen-share','share');
export const MeetingRecording:Story=meetingStory('recording','recording');
export const MeetingRecordingScreenShare:Story=meetingStory('recording-share','recording-share');
export const PhoneMeetingLibrary:Story=meetingStory('phone-library','library',true);
export const PhoneMeetingReview:Story=meetingStory('phone-review','review',true);
export const PhoneMeetingCall:Story=meetingStory('phone-call','call',true);
export const PhoneMeetingConnectionFailed:Story=meetingStory('phone-connection-failed','failed',true);
export const PhoneMeetingScreenShare:Story=meetingStory('phone-share','share',true);
