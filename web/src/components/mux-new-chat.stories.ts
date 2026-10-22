import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import { sdkChats, type SDKHarnessName } from '../lib/sdk-chats.js';
import './mux-new-chat.js';
import type { MuxNewChat } from './mux-new-chat.js';

const projects = [
  { id:'atlas', name:'Atlas', path:'/home/demo/atlas', sourceFolders:['/home/demo/notes'] },
  { id:'research', name:'Research', path:'/home/demo/research', sourceFolders:[] },
];

const fixture: ApiFixture = ({ url, method, init }) => {
  if (method === 'GET' && url.pathname.endsWith('/api/sdk-chat-start-options')) {
    return fixtureJSON([
      { harness:'codex', provider:'openai' },
      { harness:'claude', provider:'anthropic' },
      { harness:'pi', provider:'openai' },
    ]);
  }
  if (method === 'GET' && url.pathname.endsWith('/api/sdk-chat-catalog')) {
    const harness = url.searchParams.get('harness');
    const model = harness === 'claude' ? 'claude-sonnet' : 'gpt-6-sol';
    return fixtureJSON({
      model:'', effort:'', defaultModel:model,
      models:[{ id:model, label:model, efforts:['low','medium','high'], defaultEffort:'medium' }],
    });
  }
  if (method === 'GET' && url.pathname.endsWith('/api/sdk-chats')) return fixtureJSON([]);
  if (method === 'GET' && url.pathname.endsWith('/api/sdk-projects')) return fixtureJSON(projects);
  if (method === 'GET' && url.pathname.endsWith('/api/sdk-folders')) {
    const path = url.searchParams.get('path') || '/home/demo';
    const parent = path === '/home/demo' ? '/home' : path.slice(0, path.lastIndexOf('/')) || '/';
    const folders = path === '/home/demo' ? ['atlas', 'notes', 'research'] : path === '/home/demo/atlas' ? ['web', 'docs'] : [];
    return fixtureJSON({ path, base:'/home/demo', parent, folders });
  }
  if (method === 'POST' && url.pathname.endsWith('/api/sdk-projects')) {
    const request = JSON.parse(String(init?.body || '{}')) as { path?: string; name?: string };
    return fixtureJSON({ id:'new-project', name:request.name || request.path?.split('/').at(-1) || 'New project', path:request.path, sourceFolders:[] });
  }
  if (method === 'POST' && url.pathname.endsWith('/api/sdk-chat-attachments')) {
    return fixtureJSON({ id:'story-attachment', kind:'image' });
  }
  if (method === 'POST' && url.pathname.endsWith('/api/sdk-chats')) {
    const request = JSON.parse(String(init?.body || '{}')) as { prompt?: string; projectPath?: string };
    return fixtureJSON({ id:'story-chat', title:request.prompt || 'New chat', projectPath:request.projectPath || '/home/demo', harness:'codex', state:'idle', createdAt:'2026-10-21T00:00:00Z' });
  }
  return fixtureJSON({ error:`No New Chat fixture for ${method} ${url.pathname}` }, 501);
};

interface NewChatArgs {
  project: string;
  prompt: string;
  harness: SDKHarnessName;
  compact: boolean;
}

const meta = {
  title: 'Screens/New chat',
  tags: ['autodocs'],
  parameters: { layout:'fullscreen', apiFixture:fixture },
  args: { project:'', prompt:'', harness:'codex' as SDKHarnessName, compact:false },
  argTypes: {
    project: { control:'select', options:['', 'atlas', 'research'] },
    harness: { control:'select', options:['codex', 'claude', 'pi'] },
  },
  render: (args: NewChatArgs) => html`<mux-new-chat
    .initialProject=${args.project}
    .initialPrompt=${args.prompt}
    .initialHarness=${args.harness}
    .compact=${args.compact}
  ></mux-new-chat>`,
} satisfies Meta<NewChatArgs>;

export default meta;
type Story = StoryObj<NewChatArgs>;
export const Ungrouped: Story = {};
export const Project: Story = { args: { project:'atlas' } };
export const WorktreeSelected: Story = {
  args:{project:'atlas'},
  play:async ({canvasElement}) => {
    const screen = canvasElement.querySelector<MuxNewChat>('mux-new-chat');
    await sdkChats.refresh();
    for (let attempt = 0; attempt < 20; attempt++) {
      const control = screen?.shadowRoot?.querySelector<HTMLElement>('mux-ui-switch[accessible-label="Use a separate Git worktree"]');
      if (control && !control.hasAttribute('disabled')) { control.click(); return; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The project worktree switch did not enable');
  },
};
export const PhoneWorktree: Story = { args:{project:'atlas'}, globals:{viewport:{value:'phone390',isRotated:false}}, play:WorktreeSelected.play };
export const DraftMessage: Story = { args: { project:'atlas', prompt:'Summarize the open tasks in this project.' } };
export const Compact: Story = { args: { compact:true } };
export const NewProject: Story = {
  play: async ({ canvasElement }) => {
    const screen = canvasElement.querySelector<MuxNewChat>('mux-new-chat');
    if (!screen) return;
    await sdkChats.refresh();
    await screen.updateComplete;
    screen.shadowRoot?.querySelector<HTMLButtonElement>('.project-trigger')?.click();
    await screen.updateComplete;
    screen.shadowRoot?.querySelectorAll<HTMLButtonElement>('.project-option').item(3)?.click();
  },
};
export const PhoneNewProject: Story = {
  globals: { viewport:{ value:'phone390', isRotated:false } },
  play: NewProject.play,
};
export const SetupRequired: Story = {
  parameters: {
    apiFixture: ((request: Parameters<ApiFixture>[0]) => request.method === 'GET' && request.url.pathname.endsWith('/api/sdk-chat-start-options')
      ? fixtureJSON([]) : fixture(request)) satisfies ApiFixture,
  },
};
