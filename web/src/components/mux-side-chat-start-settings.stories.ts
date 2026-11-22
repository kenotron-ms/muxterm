import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import './mux-side-chat-start-settings.js';

const catalog = {
  model:'gpt-6-sol', effort:'medium', defaultModel:'gpt-6-sol',
  models:[
    { id:'gpt-6-astra', label:'GPT-6-Astra', efforts:['low','medium','high'], defaultEffort:'medium' },
    { id:'gpt-6-sol', label:'GPT-6-Sol', efforts:['low','medium','high','ultra'], defaultEffort:'medium' },
    { id:'gpt-6-luna', label:'GPT-6-Luna', efforts:['low','medium','high'], defaultEffort:'medium' },
  ],
};

const fixture: ApiFixture = ({url, method}) => {
  if (method === 'GET' && url.pathname.endsWith('/api/sdk-chats/storybook-parent'))
    return fixtureJSON({ id:'storybook-parent', harness:'codex', provider:'openai', model:'gpt-6-sol', effort:'medium', projectPath:'/workspace' });
  if (method === 'GET' && url.pathname.endsWith('/api/sdk-chat-start-options'))
    return fixtureJSON([{harness:'codex',provider:'openai'}]);
  if (method === 'GET' && url.pathname.endsWith('/api/sdk-chat-catalog'))
    return fixtureJSON(catalog);
  return fixtureJSON({error:`No side-chat fixture for ${method} ${url.pathname}`},501);
};

const meta = {
  title:'Composites/Side chat start settings',
  tags:['autodocs'],
  parameters:{layout:'fullscreen',apiFixture:fixture},
  render:() => html`
    <div style="position:fixed;inset:auto 16px 16px;box-sizing:border-box;width:calc(100% - 32px);max-width:780px;margin:auto;padding:var(--ui-space-5);border:1px solid var(--ui-border);border-radius:var(--ui-radius-xl);background:var(--ui-surface-raised)">
      <div style="min-height:52px;color:var(--ui-text-muted)">Message the side chat…</div>
      <mux-side-chat-start-settings parentId="storybook-parent" tabId="storybook-side"></mux-side-chat-start-settings>
    </div>`,
} satisfies Meta;

export default meta;
type Story = StoryObj;
export const ParentModelSelected: Story = {};
