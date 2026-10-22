import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import type { MuxSDKUtility } from './mux-sdk-utility.js';
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
    { name:'package.json', dir:false, size:489, modified:1761120000 },
  ] : path === 'docs' ? [
    { name:'design-system.md', dir:false, size:608, modified:1761120000 },
  ] : path === 'src' ? [
    { name:'app.ts', dir:false, size:716, modified:1761120000 },
  ] : [],
});

const artifacts: Record<string, {kind:'markdown'|'text'; text:string}> = {
  'README.md': {kind:'markdown',text:'# Muxterm component library\n\nA shared visual language for the terminal, chat, and project tools.\n\n## Review checklist\n\n- Browse every component in Storybook\n- Inspect the phone layout\n- Use semantic tokens for color and spacing'},
  'docs/design-system.md': {kind:'markdown',text:'# Design system\n\nUse the shared Button, Feedback, Dialog, and navigation components.\n\n**Themes** provide semantic surfaces, borders, text, accent, and focus.'},
  'src/app.ts': {kind:'text',text:'export class MuxApp {\n  render() {\n    return "Component library";\n  }\n}\n'},
  'package.json': {kind:'text',text:'{"name":"muxterm-demo","scripts":{"storybook":"storybook dev"}}'},
};

function utilityFixture(id: string, emptyPages = false): ApiFixture {
  return ({url,method}) => {
    const base = `/api/sdk-chats/${id}/utility/`;
    if (method === 'GET' && url.pathname === '/api/sdk-chats') return fixtureJSON([]);
    if (method === 'GET' && url.pathname === `/api/sdk-chats/${id}/operator`) return fixtureJSON({
      operator:{id,title:'Component library review',harness:'codex',state:'ready',operator:true,operatorLanes:[],workspaceId:'project-1',projectPath:root},lanes:[],
    });
    if (method === 'GET' && url.pathname === `${base}files`) return listing(url.searchParams.get('path') || '.');
    if (method === 'GET' && url.pathname === `${base}file`) {
      const path = url.searchParams.get('path') || '';
      const artifact = artifacts[path];
      if (!artifact) return fixtureJSON({error:'File not found'},404);
      return fixtureJSON({path,name:path.split('/').pop(),size:artifact.text.length,modified:1761120000,kind:artifact.kind,contentType:artifact.kind === 'markdown' ? 'text/markdown' : 'text/plain',text:artifact.text,tooLarge:false,maxBytes:2097152,binary:false});
    }
    if (method === 'GET' && url.pathname === `${base}search`) {
      if (id.endsWith('-search-error')) return fixtureJSON({error:'Search unavailable'},503);
      const query = (url.searchParams.get('q') || '').toLowerCase();
      return fixtureJSON({results:Object.keys(artifacts).filter(path => path.toLowerCase().includes(query)).map(path => ({path,name:path.split('/').pop(),size:artifacts[path].text.length})),truncated:false});
    }
    if (method === 'GET' && url.pathname === `${base}changes`) return fixtureJSON({repos:[{root,name:'muxterm',branch:'design-system'}],changes:[{repo:root,path:'README.md',status:' M'},{repo:root,path:'src/app.ts',status:' M'}],truncated:false});
    if (method === 'GET' && url.pathname === `${base}change`) return fixtureJSON({repo:root,path:url.searchParams.get('path'),before:'# Muxterm\n',after:'# Muxterm component library\n',binary:false,tooLarge:false});
    if (method === 'GET' && url.pathname === `${base}pages`) return fixtureJSON({version:1,pages:emptyPages ? [] : [
      {id:'review-page',title:id.endsWith('-subpage') ? 'Document actions review' : 'Component review',blocks:[],content:[{type:'paragraph',content:'Review the shared controls and phone layout.'}]},
      ...(id.endsWith('-subpage') ? [{id:'child-page',parentId:'review-page',title:'Phone child review of document actions',blocks:[],content:[{type:'paragraph',content:'Check the page breadcrumb.'}]}] : []),
    ]});
    if (method === 'PUT' && url.pathname === `${base}pages`) return fixtureJSON({version:2});
    return fixtureJSON({error:`No utility fixture for ${method} ${url.pathname}`},501);
  };
}

interface UtilityArgs { sessionId:string }
const meta = {
  title:'Screens/Utility', tags:['autodocs'],
  parameters:{layout:'fullscreen',fullBleed:true,apiFixture:utilityFixture(sessionId('files'))},
  args:{sessionId:sessionId('files')},
  render:(args:UtilityArgs) => html`<div style="width:100%;height:100vh"><mux-sdk-utility .sessionId=${args.sessionId} .projectPath=${root} .touched=${['docs/design-system.md']}></mux-sdk-utility></div>`,
} satisfies Meta<UtilityArgs>;
export default meta;
type Story = StoryObj<UtilityArgs>;

function target(canvasElement: HTMLElement): MuxSDKUtility | null { return canvasElement.querySelector('mux-sdk-utility'); }

export const Files: Story = {};
export const FilePreview: Story = {
  args:{sessionId:sessionId('preview')},parameters:{apiFixture:utilityFixture(sessionId('preview'))},
  play:async ({canvasElement}) => { await target(canvasElement)?.showFile('README.md'); },
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
export const Pages: Story = {
  args:{sessionId:sessionId('pages')},parameters:{apiFixture:utilityFixture(sessionId('pages'))},
  play:async ({canvasElement}) => { target(canvasElement)?.showPanel('pages'); },
};
export const EmptyPages: Story = {
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
export const PhonePages: Story = {
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
      button = target(canvasElement)?.querySelector<MuxUIButton>('mux-ui-button[accessible-label="Delete page Component review"]') || null;
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
