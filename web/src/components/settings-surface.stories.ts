import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from '../lib/config.js';
import { DEFAULT_AI_STATUS, type AIStatus } from '../lib/ai.js';
import { DEFAULT_VOICE_STATUS, type VoiceStatus } from '../lib/voice-settings.js';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import '../ui/dialog.js';
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

function onConfigChange(event: Event): void {
  (event.target as MuxSettingsSurface).config =
    (event as CustomEvent<{ config: ResolvedConfig }>).detail.config;
}

interface SettingsArgs { section: SettingsSection; aiStatus: AIStatus }

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
    <mux-ui-dialog open label="Settings">
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
export const PhoneAppearance: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
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
  play:LightAppearance.play,
};
export const Notifications: Story = { args: { section:'notifications' } };
export const PhoneNotifications: Story = { args:{section:'notifications'}, globals:{viewport:{value:'phone390',isRotated:false}} };
export const AIOff: Story = { args: { section:'ai' } };
export const AIConfigured: Story = {
  args: { section:'ai', aiStatus:{ enabled:true, source:'settings', keyHint:'demo' } },
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
};
export const VoiceAzureKeyMissing: Story = {
  args: { section:'voice' },
  parameters: { apiFixture:fixtureForVoice(azureKeyMissing) },
};
export const Remotes: Story = { args: { section:'remotes' } };
export const Workspaces: Story = { args: { section:'workspaces' } };
export const KeyboardShortcuts: Story = { args: { section:'shortcuts' } };
export const AboutDevelopmentBuild: Story = { args: { section:'about' } };
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
