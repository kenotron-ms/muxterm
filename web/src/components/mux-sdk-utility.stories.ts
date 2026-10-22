import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import type { MuxSDKUtility } from './mux-sdk-utility.js';
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

function utilityFixture(id: string): ApiFixture {
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
      const query = (url.searchParams.get('q') || '').toLowerCase();
      return fixtureJSON({results:Object.keys(artifacts).filter(path => path.toLowerCase().includes(query)).map(path => ({path,name:path.split('/').pop(),size:artifacts[path].text.length})),truncated:false});
    }
    if (method === 'GET' && url.pathname === `${base}changes`) return fixtureJSON({repos:[{root,name:'muxterm',branch:'design-system'}],changes:[{repo:root,path:'README.md',status:' M'},{repo:root,path:'src/app.ts',status:' M'}],truncated:false});
    if (method === 'GET' && url.pathname === `${base}change`) return fixtureJSON({repo:root,path:url.searchParams.get('path'),before:'# Muxterm\n',after:'# Muxterm component library\n',binary:false,tooLarge:false});
    if (method === 'GET' && url.pathname === `${base}pages`) return fixtureJSON({version:1,pages:[{id:'review-page',title:'Component review',blocks:[],content:[{type:'paragraph',content:'Review the shared controls and phone layout.'}]}]});
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
export const FileOpenActions: Story = {
  args:{sessionId:sessionId('file-actions')},parameters:{apiFixture:utilityFixture(sessionId('file-actions'))},
  play:async ({canvasElement}) => {
    const utility = target(canvasElement);
    await utility?.showFile('README.md');
    utility?.querySelector<HTMLButtonElement>('.file-open-button')?.click();
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
    utility?.querySelector<HTMLButtonElement>('button[aria-label="Quick open file"]')?.click();
  },
};
export const PhoneQuickOpen: Story = {
  args:{sessionId:sessionId('phone-quick-open')},parameters:{apiFixture:utilityFixture(sessionId('phone-quick-open'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:QuickOpen.play,
};
export const Changes: Story = {
  args:{sessionId:sessionId('changes')},parameters:{apiFixture:utilityFixture(sessionId('changes'))},
  play:async ({canvasElement}) => { target(canvasElement)?.showPanel('changes'); },
};
export const Pages: Story = {
  args:{sessionId:sessionId('pages')},parameters:{apiFixture:utilityFixture(sessionId('pages'))},
  play:async ({canvasElement}) => { target(canvasElement)?.showPanel('pages'); },
};
export const Status: Story = {
  args:{sessionId:sessionId('status')},parameters:{apiFixture:utilityFixture(sessionId('status'))},
  play:async ({canvasElement}) => { target(canvasElement)?.showPanel('status'); },
};
export const NewTab: Story = {
  args:{sessionId:sessionId('new')},parameters:{apiFixture:utilityFixture(sessionId('new'))},
  play:async ({canvasElement}) => { target(canvasElement)?.querySelector<HTMLButtonElement>('button[aria-label="New tab"]')?.click(); },
};
export const PhoneFiles: Story = {
  args:{sessionId:sessionId('phone')},parameters:{apiFixture:utilityFixture(sessionId('phone'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:async ({canvasElement}) => { await target(canvasElement)?.showFile('README.md'); },
};
export const PhonePages: Story = {
  args:{sessionId:sessionId('phone-pages')},parameters:{apiFixture:utilityFixture(sessionId('phone-pages'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:async ({canvasElement}) => { target(canvasElement)?.showPanel('pages'); },
};
export const PhonePageDeleteConfirmation: Story = {
  args:{sessionId:sessionId('phone-page-delete')},parameters:{apiFixture:utilityFixture(sessionId('phone-page-delete'))},
  globals:{viewport:{value:'phone390',isRotated:false}},
  play:async ({canvasElement}) => {
    target(canvasElement)?.showPanel('pages');
    let button: HTMLButtonElement | null = null;
    for (let attempt=0; attempt<40 && !button; attempt++) {
      button = target(canvasElement)?.querySelector<HTMLButtonElement>('button[aria-label="Delete page Component review"]') || null;
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
