import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import './mux-sdk-chat-settings.js';

const codex = {
  model:'gpt-6-sol', effort:'medium', permission:'full-permission', mode:'agent',
  permissions:['read-only','workspace-write','full-permission'], modes:['agent','plan'],
  models:[
    { id:'gpt-6-astra', label:'GPT-6-Astra', efforts:['low','medium','high'], defaultEffort:'medium' },
    { id:'gpt-6-sol', label:'GPT-6-Sol', efforts:['low','medium','high','ultra'], defaultEffort:'medium' },
    { id:'gpt-6-luna', label:'GPT-6-Luna', efforts:['low','medium','high'], defaultEffort:'medium' },
  ],
};

const claude = {
  model:'claude-sonnet', effort:'medium', permission:'read-only', mode:'plan',
  permissions:['read-only','workspace-write','full-permission'], modes:['agent','plan'],
  models:[
    { id:'claude-sonnet', label:'Claude Sonnet', efforts:['low','medium','high'], defaultEffort:'medium' },
    { id:'claude-opus', label:'Claude Opus', efforts:['medium','high'], defaultEffort:'medium' },
  ],
};

const amplifier = {
  model:'amplifier-default', effort:'', permission:'full-permission', mode:'careful',
  permissions:[], modes:[], bundle:'developer', provider:'provider-openai',
  bundles:['developer','research'], providers:['provider-openai','provider-anthropic'],
  modeOptions:[
    { name:'careful', description:'Check each step before changing files.' },
    { name:'explore', description:'Inspect the project and report findings.' },
    { name:'plan', description:'Prepare a plan before acting.' },
  ],
  models:[{ id:'amplifier-default', label:'Bundle default', efforts:[] }],
};

function settingsFixture(initial: Record<string, unknown>, failLoad = false): ApiFixture {
  let settings = { ...initial };
  return ({ url, method, init }) => {
    if (url.pathname.endsWith('/api/sdk-chats/storybook-chat/settings')) {
      if (method === 'GET') return failLoad
        ? new Response('Settings are unavailable for this chat.', { status:503 })
        : fixtureJSON(settings);
      if (method === 'PATCH') {
        settings = { ...settings, ...JSON.parse(String(init?.body || '{}')) as Record<string, unknown> };
        return fixtureJSON(settings);
      }
    }
    return fixtureJSON({ error:`No chat-settings fixture for ${method} ${url.pathname}` }, 501);
  };
}

interface ChatSettingsArgs { harness: string; turnBusy: boolean }

const meta = {
  title:'Composites/Chat settings',
  tags:['autodocs'],
  parameters:{ layout:'fullscreen', apiFixture:settingsFixture(codex) },
  args:{ harness:'codex', turnBusy:false },
  argTypes:{ harness:{ control:'select', options:['codex','claude','amplifier'] } },
  render:(args: ChatSettingsArgs) => html`
    <div style="position:fixed;inset:auto 16px 16px;box-sizing:border-box;width:calc(100% - 32px);max-width:780px;margin:auto;padding:var(--ui-space-5);border:1px solid var(--ui-border);border-radius:var(--ui-radius-xl);background:var(--ui-surface-raised)">
      <div style="min-height:52px;color:var(--ui-text-muted)">Message the agent…</div>
      <mux-sdk-chat-settings sessionId="storybook-chat" .harness=${args.harness} .turnBusy=${args.turnBusy}></mux-sdk-chat-settings>
    </div>`,
} satisfies Meta<ChatSettingsArgs>;

export default meta;
type Story = StoryObj<ChatSettingsArgs>;
export const Codex: Story = {};
export const ClaudePlan: Story = { args:{ harness:'claude' }, parameters:{ apiFixture:settingsFixture(claude) } };
export const Amplifier: Story = { args:{ harness:'amplifier' }, parameters:{ apiFixture:settingsFixture(amplifier) } };
export const TurnBusy: Story = { args:{ turnBusy:true } };
export const LoadError: Story = { parameters:{ apiFixture:settingsFixture(codex,true) } };
