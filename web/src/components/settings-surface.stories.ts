import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from '../lib/config.js';
import { DEFAULT_AI_STATUS, type AIStatus } from '../lib/ai.js';
import { DEFAULT_VOICE_STATUS, type VoiceStatus } from '../lib/voice-settings.js';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import '../ui/dialog.js';
import type { MuxUITextField } from '../ui/text-field.js';
import './settings-surface.js';
import type { MuxSettingsSurface, SettingsSection } from './settings-surface.js';

const remotes = {
  connected: [
    { id:'ssh:build-box', name:'build-box', target:'dev@build-box', transport:'ssh', managed:true, state:'connected', probe:'present' },
  ],
  discovered: [
    { id:'ssh:gpu-01', name:'gpu-01', target:'dev@gpu-01', transport:'ssh', managed:false, state:'never-connected', probe:'present' },
    { id:'ssh:research-lab', name:'research-lab', target:'dev@research-lab.example', transport:'ssh', managed:true, state:'never-connected', probe:'absent' },
  ],
  errors: [
    { id:'ssh:archive', name:'archive', target:'dev@archive', transport:'ssh', managed:true, state:'unreachable', probe:'unknown', error:'No route to host' },
  ],
};

const openAIConfigured: VoiceStatus = {
  ...DEFAULT_VOICE_STATUS,
  enabled:true,
  mode:'openai_key',
  endpoint:'https://api.openai.com/v1',
  model:'gpt-realtime-2.1',
  keySource:'stored',
  keyConfigured:true,
  configPath:'~/.config/muxterm/config.toml',
  keyPath:'~/.config/muxterm/voice_api_key',
};

const azureEntra: VoiceStatus = {
  ...DEFAULT_VOICE_STATUS,
  enabled:true,
  mode:'azure_entra',
  endpoint:'https://team.openai.azure.com/openai/v1',
  model:'gpt-realtime',
  entraScope:'https://ai.azure.com/.default',
  allowedScopes:['https://ai.azure.com/.default', 'https://cognitiveservices.azure.com/.default'],
  configPath:'~/.config/muxterm/config.toml',
};

const azureKeyMissing: VoiceStatus = {
  ...DEFAULT_VOICE_STATUS,
  mode:'azure_key',
  endpoint:'https://team.openai.azure.com/openai/v1',
  model:'gpt-realtime',
  configPath:'~/.config/muxterm/config.toml',
};

function fixtureForVoice(initialVoice: VoiceStatus): ApiFixture {
  let voice = initialVoice;
  return ({ url, method, init }) => {
    if (url.pathname.endsWith('/api/remotes') && method === 'GET') return fixtureJSON(remotes);
    if (url.pathname.endsWith('/api/sdk-chat-start-options') && method === 'GET') return fixtureJSON([
      {harness:'codex',provider:'openai'}, {harness:'amplifier',provider:'configured'},
    ]);
    if (url.pathname.endsWith('/api/ai/antigravity/auth') && method === 'GET') return fixtureJSON({mode:'google',apiKeyDetected:false,installed:false,installSupported:true});
    if (url.pathname.endsWith('/api/ai/antigravity/login') && method === 'GET') return fixtureJSON({state:'idle'});
    if (url.pathname.includes('/api/ai/agents/') && url.pathname.endsWith('/install') && method === 'POST') return fixtureJSON({installed:true});
    if (url.pathname.endsWith('/api/update/status') && method === 'GET') return fixtureJSON({
      currentVersion:'0.14.0', latestVersion:'0.14.0', updateAvailable:false,
      canUpdate:false, devBuild:true, method:'unsupported', reason:'Development build',
    });
    if (url.pathname.endsWith('/api/voice/settings')) {
      if (method === 'GET') return fixtureJSON(voice);
      if (method === 'PUT') {
        const input = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        voice = {
          ...voice,
          enabled:input['enabled'] === true,
          mode:input['mode'] === 'azure_entra' || input['mode'] === 'azure_key' || input['mode'] === 'openai_key' ? input['mode'] : voice.mode,
          endpoint:String(input['endpoint'] ?? ''),
          model:String(input['model'] ?? ''),
          entraScope:String(input['entraScope'] ?? ''),
          keyConfigured:typeof input['apiKey'] === 'string' && input['apiKey'] !== '' ? true : voice.keyConfigured,
          keySource:typeof input['apiKey'] === 'string' && input['apiKey'] !== '' ? 'stored' : voice.keySource,
        };
        return fixtureJSON(voice);
      }
    }
    if (url.pathname.endsWith('/api/voice/key') && method === 'DELETE') {
      voice = { ...voice, enabled:false, keyConfigured:false, keySource:'none' };
      return fixtureJSON(voice);
    }
    if (url.pathname.endsWith('/api/voice/check') && method === 'POST') {
      if (voice.mode !== 'azure_entra' && !voice.keyConfigured) {
        return fixtureJSON({ ok:false, detail:'No credential is configured for this mode.' }, 400);
      }
      return fixtureJSON({ ok:true, detail:'The Storybook sign-in fixture responded.' });
    }
    if (url.pathname.endsWith('/api/ai/key') && method === 'PUT') {
      return fixtureJSON({ enabled:true, source:'settings', keyHint:'demo' });
    }
    if (url.pathname.endsWith('/api/ai/key') && method === 'DELETE') {
      return fixtureJSON(DEFAULT_AI_STATUS);
    }
    if (url.pathname.endsWith('/api/ai/ping') && method === 'POST') {
      return fixtureJSON({ ok:true });
    }
    return fixtureJSON({ error:`No Storybook fixture for ${method} ${url.pathname}` }, 501);
  };
}

function remotesLoadFailureFixture(): ApiFixture {
  const base = fixtureForVoice(DEFAULT_VOICE_STATUS);
  let failed = false;
  return request => {
    if (request.url.pathname.endsWith('/api/remotes') && request.method === 'GET' && !failed) {
      failed = true;
      return fixtureJSON({ error:'Could not load remote hosts. Try again.' }, 503);
    }
    return base(request);
  };
}

function remotesAddFailureFixture(): ApiFixture {
  const base = fixtureForVoice(DEFAULT_VOICE_STATUS);
  return request => request.url.pathname.endsWith('/api/remotes') && request.method === 'POST'
    ? fixtureJSON({ error:'That host address could not be added.' }, 400)
    : base(request);
}

function aiConnectionFailureFixture(): ApiFixture {
  const base = fixtureForVoice(DEFAULT_VOICE_STATUS);
  return request => request.url.pathname.endsWith('/api/ai/ping') && request.method === 'POST'
    ? fixtureJSON({ ok:false, error:'provider_unreachable' }, 503)
    : base(request);
}

function updateCheckFailureFixture(): ApiFixture {
  const base = fixtureForVoice(DEFAULT_VOICE_STATUS);
  return request => request.url.pathname.endsWith('/api/update/status') && request.method === 'GET'
    ? fixtureJSON({ error:'Version service unavailable.' }, 503)
    : base(request);
}

async function submitRejectedHost(canvasElement: HTMLElement): Promise<void> {
  const settings = canvasElement.querySelector<MuxSettingsSurface>('mux-settings-surface');
  await settings?.updateComplete;
  const field = settings?.shadowRoot?.querySelector<MuxUITextField>('mux-ui-text-field[aria-label="Host address"]');
  await field?.updateComplete;
  const input = field?.shadowRoot?.querySelector('input');
  if (!input || !settings) throw new Error('Host address field is missing');
  input.value = 'bad host';
  input.dispatchEvent(new InputEvent('input', { bubbles:true, composed:true }));
  await settings.updateComplete;
  const add = [...settings.shadowRoot!.querySelectorAll('mux-ui-button')].find(button => button.textContent?.trim() === 'Add host');
  if (!add) throw new Error('Add host action is missing');
  add.click();
}

function onConfigChange(event: Event): void {
  (event.target as MuxSettingsSurface).config =
    (event as CustomEvent<{ config: ResolvedConfig }>).detail.config;
}

interface SettingsArgs { section: SettingsSection; aiStatus: AIStatus }

const renderPhonePage = (args: SettingsArgs) => html`<div style="height:100dvh;display:flex;background:var(--ui-surface-base)">
  <mux-settings-surface
    page-mode
    .config=${DEFAULT_RESOLVED_CONFIG}
    .aiStatus=${args.aiStatus}
    .openSection=${args.section}
    serverAddr="muxterm.example.test"
    @config-change=${onConfigChange}
  ></mux-settings-surface>
</div>`;

const meta = {
  title: 'Screens/Settings',
  tags: ['autodocs'],
  parameters: { layout:'fullscreen', apiFixture:fixtureForVoice(DEFAULT_VOICE_STATUS) },
  args: { section:'appearance' as SettingsSection, aiStatus:DEFAULT_AI_STATUS },
  argTypes: {
    section: { control:'select', options:['appearance','notifications','workspaces','ai','voice','remotes','shortcuts','about'] },
    aiStatus: { control:false },
  },
  render: (args: SettingsArgs) => html`
    <mux-ui-dialog open size="wide" label="Settings">
      <div style="flex:1;min-height:0;overflow:hidden">
        <mux-settings-surface
          .config=${DEFAULT_RESOLVED_CONFIG}
          .aiStatus=${args.aiStatus}
          .openSection=${args.section}
          serverAddr="muxterm.example.test"
          @config-change=${onConfigChange}
        ></mux-settings-surface>
      </div>
    </mux-ui-dialog>
  `,
} satisfies Meta<SettingsArgs>;

export default meta;
type Story = StoryObj<SettingsArgs>;
export const Appearance: Story = {};
export const PhoneAppearance: Story = { globals:{viewport:{value:'phone390',isRotated:false}}, render:renderPhonePage };
export const LightAppearance: Story = {
  globals:{palette:'github-light'},
  play:async ({canvasElement}) => {
    const settings = canvasElement.querySelector<MuxSettingsSurface>('mux-settings-surface');
    await settings?.updateComplete;
    settings?.shadowRoot?.querySelector<HTMLElement>('mux-ui-theme-choice[label="GitHub"]')?.click();
    await settings?.updateComplete;
  },
};
export const PhoneLightAppearance: Story = {
  globals:{palette:'github-light',viewport:{value:'phone390',isRotated:false}},
  render:renderPhonePage,
  play:LightAppearance.play,
};
export const Notifications: Story = { args: { section:'notifications' } };
export const PhoneNotifications: Story = { args:{section:'notifications'}, globals:{viewport:{value:'phone390',isRotated:false}}, render:renderPhonePage };
async function showNotificationPermission(canvasElement: HTMLElement, permission: NotificationPermission | 'unsupported') {
  const settings = canvasElement.querySelector<MuxSettingsSurface>('mux-settings-surface');
  if (!settings) return;
  await settings.updateComplete;
  Object.assign(settings, { _notifPermission:permission });
  await settings.updateComplete;
}
export const NotificationsEnabled: Story = {
  args:{section:'notifications'},
  play:({canvasElement}) => showNotificationPermission(canvasElement, 'granted'),
};
export const NotificationsBlocked: Story = {
  args:{section:'notifications'},
  play:({canvasElement}) => showNotificationPermission(canvasElement, 'denied'),
};
export const PhoneNotificationsBlocked: Story = {
  args:{section:'notifications'},
  globals:{viewport:{value:'phone390',isRotated:false}},
  render:renderPhonePage,
  play:({canvasElement}) => showNotificationPermission(canvasElement, 'denied'),
};
export const NotificationsUnsupported: Story = {
  args:{section:'notifications'},
  play:({canvasElement}) => showNotificationPermission(canvasElement, 'unsupported'),
};
export const AIOff: Story = { args: { section:'ai' } };
export const AIAgentInstall: Story = {
  args:{section:'ai'},
  play:async ({canvasElement}) => {
    const settings = canvasElement.querySelector<MuxSettingsSurface>('mux-settings-surface');
    await settings?.updateComplete;
    const claude = [...(settings?.shadowRoot?.querySelectorAll('details.agent-card summary') ?? [])]
      .find(summary => summary.textContent?.includes('Claude Code'));
    if (!claude) throw new Error('Claude Code row is missing');
    (claude as HTMLElement).click();
  },
};
export const AIConfigured: Story = {
  args: { section:'ai', aiStatus:{ enabled:true, source:'settings', keyHint:'demo' } },
};
export const AIConnectionError: Story = {
  args:{section:'ai',aiStatus:{enabled:true,source:'settings',keyHint:'demo'}},
  parameters:{apiFixture:aiConnectionFailureFixture()},
  play:async ({canvasElement}) => {
    const settings = canvasElement.querySelector<MuxSettingsSurface>('mux-settings-surface');
    await settings?.updateComplete;
    const test = [...(settings?.shadowRoot?.querySelectorAll('mux-ui-button') ?? [])].find(button => button.textContent?.trim() === 'Test connection');
    if (!test) throw new Error('Test connection action is missing');
    test.click();
  },
};
export const VoiceOpenAIKey: Story = {
  args: { section:'voice' },
  parameters: { apiFixture:fixtureForVoice(openAIConfigured) },
};
export const VoiceAzureEntra: Story = {
  args: { section:'voice' },
  parameters: { apiFixture:fixtureForVoice(azureEntra) },
};
export const PhoneVoiceAzureEntra: Story = {
  args:{section:'voice'}, globals:{viewport:{value:'phone390',isRotated:false}},
  parameters:{apiFixture:fixtureForVoice(azureEntra)},
  render:renderPhonePage,
};
export const VoiceAzureKeyMissing: Story = {
  args: { section:'voice' },
  parameters: { apiFixture:fixtureForVoice(azureKeyMissing) },
};
export const Remotes: Story = { args: { section:'remotes' } };
export const RemotesLoadError: Story = { args:{section:'remotes'}, parameters:{apiFixture:remotesLoadFailureFixture()} };
export const PhoneRemotesLoadError: Story = { args:{section:'remotes'}, globals:{viewport:{value:'phone390',isRotated:false}}, parameters:{apiFixture:remotesLoadFailureFixture()}, render:renderPhonePage };
export const PhoneRemotesAddError: Story = { args:{section:'remotes'}, globals:{viewport:{value:'phone390',isRotated:false}}, parameters:{apiFixture:remotesAddFailureFixture()}, render:renderPhonePage, play:async ({canvasElement}) => submitRejectedHost(canvasElement) };
export const Workspaces: Story = { args: { section:'workspaces' } };
export const KeyboardShortcuts: Story = { args: { section:'shortcuts' } };
export const AboutDevelopmentBuild: Story = { args: { section:'about' } };
export const AboutCheckError: Story = { args:{section:'about'}, parameters:{apiFixture:updateCheckFailureFixture()} };
export const RemotesPageMode: Story = {
  args: { section:'remotes' },
  render: (args: SettingsArgs) => html`<div style="height:100vh;min-height:500px">
    <mux-settings-surface
      page-mode
      .config=${DEFAULT_RESOLVED_CONFIG}
      .aiStatus=${args.aiStatus}
      .openSection=${args.section}
      serverAddr="muxterm.example.test"
      @config-change=${onConfigChange}
    ></mux-settings-surface>
  </div>`,
};
