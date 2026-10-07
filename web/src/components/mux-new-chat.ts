import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sdkChats, sdkHarnessLabel, type FolderListing, type SDKHarnessName } from '../lib/sdk-chats.js';
import { apiPath } from '../lib/base-path.js';
import { ChevronDown, Folder, Plus } from 'lucide';
import { icon } from '../lib/icons.js';
import { carryUtilityTabs, type MuxSDKUtility } from './mux-sdk-utility.js';

type ProviderName = 'openai' | 'anthropic' | 'configured';
type StartOption = { harness: SDKHarnessName; provider: ProviderName };
type AmplifierProviderState = { id: string; source?: 'environment' | 'amplifier-keys' | 'oauth-cache'; envName?: string };
type AmplifierProviderSetup = { cliInstalled: boolean; configured: boolean; primary: string; providers: AmplifierProviderState[] };
const AI_PROVIDERS = [
  { id:'github-copilot', name:'GitHub Copilot', detail:'Use an existing Copilot subscription. Sign-in may already be available through GitHub or VS Code.' },
  { id:'openai-chatgpt', name:'ChatGPT', detail:'Use a ChatGPT subscription with device-code sign-in.' },
  { id:'openai', name:'OpenAI API', detail:'Use an API key with separate usage billing.' },
  { id:'anthropic', name:'Anthropic API', detail:'Use an Anthropic API key.' },
  { id:'gemini', name:'Google Gemini API', detail:'Use a Google API key.' },
] as const;
const SETUP_AGENTS = [
  { harness:'codex', name:'Codex', command:'curl -fsSL https://chatgpt.com/codex/install.sh | sh', login:'codex login', docs:'https://learn.chatgpt.com/docs/codex/cli' },
  { harness:'claude', name:'Claude Code', command:'curl -fsSL https://claude.ai/install.sh | bash', login:'claude', docs:'https://code.claude.com/docs/en/setup' },
  { harness:'opencode', name:'OpenCode', command:'curl -fsSL https://opencode.ai/install | bash', login:'opencode auth login', docs:'https://opencode.ai/docs/' },
  { harness:'pi', name:'Pi', command:'npm install -g @mariozechner/pi-coding-agent pi-acp', login:'pi', docs:'https://github.com/svkozak/pi-acp' },
  { harness:'deepseek', name:'DeepSeek Harness', command:'npm install -g @deepseek-ai/dsh', login:'dsh web', docs:'https://github.com/deepseek-ai/deepseek-harness' },
  { harness:'amplifier', name:'Amplifier', command:'export PATH="$HOME/.local/bin:$PATH"; command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh; uv tool install git+https://github.com/microsoft/amplifier', login:'export PATH="$HOME/.local/bin:$PATH"; amplifier init', docs:'https://github.com/microsoft/amplifier/blob/main/docs/USER_ONBOARDING.md' },
] as const;
type Attachment = { localId: string; file: File; id?: string; kind?: string; preview?: string; uploading: boolean; error?: string };

@customElement('mux-new-chat')
export class MuxNewChat extends LitElement {
  @property() initialHarness: SDKHarnessName = 'codex';
  @property() initialFolder = '';
  @property() initialProject = '';
  @property() initialPrompt = '';
  @property() draftId = '';
  @property() terminalWorkspaceId = '';
  @state() private projectId = 'ungrouped';
  @state() private folder = '';
  @state() private workMode: 'local' | 'worktree' = 'local';
  @state() private projectName = '';
  @state() private newFolderName = '';
  @state() private harness: SDKHarnessName = 'codex';
  @state() private provider: ProviderName = 'openai';
  @state() private startOptions?: StartOption[];
  @state() private prompt = '';
  @state() private listing?: FolderListing;
  @state() private pickerOpen = false;
  @state() private locationOpen = false;
  @state() private projectPickerOpen = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private utilityOpen = false;
  @state() private terminalRequested = false;
  @state() private firstRun = false;
  @state() private onboardingLoaded = false;
  @state() private onboardingError = '';
  @state() private optionsLoaded = false;
  @state() private amplifierProviderSetup?: AmplifierProviderSetup;
  @state() private chosenAIProvider = '';
  @state() private providerError = '';
  @state() private providerCheckBusy = false;
  @state() private providerChecked = '';
  @state() private providerCheckError = '';
  @state() private setupStep: 'provider' | 'harness' = 'provider';
  @state() private providerSettingsOpen = false;
  @state() private attachments: Attachment[] = [];
  @state() private dropActive = false;
  private dragDepth = 0;
  private optionsRefreshTimer?: number;
  private optionsRefreshing = false;
  private hasFiles(event: DragEvent) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }
  private preventFileNavigation = (event: DragEvent) => { if (this.hasFiles(event)) event.preventDefault(); };
  private resetDrop = () => { this.dragDepth = 0; this.dropActive = false; };
  private unsub?: () => void;
  private readonly closeDropdowns = (event: PointerEvent) => {
    const path = event.composedPath();
    const inside = (selector: string) => {
      const element = this.renderRoot.querySelector(selector);
      return element !== null && path.includes(element);
    };
    if (this.projectPickerOpen && !inside('.project-picker')) this.projectPickerOpen = false;
    if (this.pickerOpen && !inside('.picker') && !inside('.browse')) this.pickerOpen = false;
    if (this.locationOpen && !inside('.location-settings')) this.locationOpen = false;
  };

  static styles = css`
    ${subtleScrollbars}
    :host { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column; background:var(--chrome-body); color:var(--chrome-text-bright); font:13px/1.5 system-ui,sans-serif; }
    .layout { flex:1; display:flex; min-width:0; min-height:0; }
    .utility-drawer { display:flex; flex-direction:column; flex:none; box-sizing:border-box; width:min(48%,620px); min-width:320px; min-height:0; border-left:1px solid var(--chrome-border); background:var(--chrome-bar); }
    .utility-drawer > header { display:flex; align-items:center; justify-content:space-between; flex:none; height:39px; padding:0 12px; color:var(--chrome-text-dim); font-size:11px; }
    .utility-drawer > header button { border:0; border-radius:6px; padding:3px 8px; background:transparent; color:var(--chrome-text-bright); }
    .utility-drawer > header button:hover { background:var(--chrome-hover); }
    .utility-drawer mux-sdk-utility { flex:1; min-height:0; }
    .composer-tools { display:flex; justify-content:flex-end; width:min(100%,780px); margin:0 0 12px; }
    .composer-tools button { padding:7px 11px; border:1px solid var(--chrome-border); border-radius:8px; background:var(--chrome-bar); color:var(--chrome-text-bright); }
    .main { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; align-items:center; padding:24px; overflow:auto; }
    .main.setup { justify-content:flex-start; }
    .main.setup .content { width:min(100%,1060px); }
    .content { width:min(100%,780px); }
    h1 { font-size:28px; font-weight:600; margin:0 0 20px; }
    .controls { display:flex; align-items:center; flex-wrap:wrap; gap:7px; padding-bottom:9px; border-bottom:1px solid var(--chrome-border,#475067); }
    label { display:flex; flex-direction:column; gap:5px; color:var(--chrome-text-dim,#a9b0c0); font-size:11px; }
    .controls label { display:block; }
    .controls .project { min-width:0; }
    .controls .harness { min-width:0; }
    .worktree-toggle { display:inline-flex; align-items:center; gap:7px; height:31px; margin-left:auto; padding:0 3px 0 8px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--chrome-text-dim,#a9b0c0); font-size:12px; white-space:nowrap; }
    .worktree-toggle:hover:not(:disabled),.worktree-toggle:focus-visible { background:var(--chrome-hover); color:var(--chrome-text-bright,#e2e6f1); outline:none; }
    .worktree-toggle:disabled { opacity:.45; cursor:default; }
    .worktree-toggle .track { display:flex; align-items:center; box-sizing:border-box; width:29px; height:17px; padding:2px; border:1px solid var(--chrome-border,#475067); border-radius:999px; background:var(--chrome-body); transition:background .15s; }
    .worktree-toggle .thumb { width:11px; height:11px; border-radius:50%; background:var(--chrome-text-dim,#a9b0c0); transition:transform .15s; }
    .worktree-toggle[aria-checked="true"] { color:var(--chrome-text-bright,#e2e6f1); }
    .worktree-toggle[aria-checked="true"] .track { border-color:var(--chrome-accent,#9bb8f7); background:var(--chrome-accent,#9bb8f7); }
    .worktree-toggle[aria-checked="true"] .thumb { background:var(--chrome-body); transform:translateX(12px); }
    .composer-actions { display:flex; align-items:center; gap:7px; padding-top:8px; border-top:1px solid var(--chrome-border,#475067); }
    .composer-actions .send { margin-left:auto; }
    select,input { box-sizing:border-box; width:100%; height:37px; border:1px solid var(--chrome-border,#475067); border-radius:8px; background:var(--chrome-bar,#252a39); color:var(--chrome-text-bright,#e2e6f1); padding:7px 9px; font:13px system-ui,sans-serif; }
    select { appearance:none; padding-right:29px; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23a9b9d6' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right 8px center; }
    .controls select { height:31px; max-width:130px; padding:3px 29px 3px 9px; font-size:12px; }
    select:hover,.browse:hover { border-color:var(--chrome-accent,#9bb8f7); }
    select:focus-visible,input:focus-visible,.browse:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .project-picker { position:relative; }
    .project-trigger { box-sizing:border-box; width:auto; max-width:150px; height:31px; display:flex; align-items:center; gap:6px; padding:0 9px; border:1px solid var(--chrome-border,#475067); border-radius:8px; background:color-mix(in srgb,var(--chrome-accent,#9bb8f7) 9%,var(--chrome-bar,#252a39)); color:var(--chrome-text-bright,#e2e6f1); font-size:12px; font-weight:600; text-align:left; }
    .project-trigger:hover,.project-trigger[aria-expanded="true"] { border-color:var(--chrome-accent,#9bb8f7); }
    .project-trigger:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .project-trigger .project-name { flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .project-trigger .project-symbol { display:flex; color:var(--chrome-accent,#9bb8f7); }
    .project-trigger .down { display:flex; margin-left:auto; color:var(--chrome-text-dim,#a9b0c0); }
    .project-options { position:absolute; z-index:20; top:36px; left:0; width:270px; max-width:min(270px,calc(100vw - 72px)); max-height:280px; overflow:auto; padding:5px; border:1px solid var(--chrome-border,#475067); border-radius:10px; background:var(--chrome-bar,#252a39); box-shadow:0 12px 30px #0009; }
    .project-option { width:100%; display:flex; align-items:center; gap:9px; padding:8px; border:0; border-radius:6px; background:transparent; color:var(--chrome-text-bright,#e2e6f1); text-align:left; }
    .project-option:hover,.project-option[selected] { background:color-mix(in srgb,var(--chrome-accent,#9bb8f7) 15%,transparent); }
    .project-option .option-copy { flex:1; min-width:0; display:grid; gap:1px; }
    .project-option .option-copy strong,.project-option .option-copy small { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .project-option .option-copy small { color:var(--chrome-text-dim,#a9b0c0); font-size:10px; }
    .project-option svg { flex:none; color:var(--chrome-accent,#9bb8f7); }
    .project-divider { height:1px; margin:4px 6px; background:var(--chrome-border,#475067); }
    .folder-line { display:flex; gap:6px; }
    .folder-line input { flex:1; min-width:0; }
    button { cursor:pointer; font:inherit; }
    .browse { border:1px solid var(--chrome-border,#475067); border-radius:8px; color:inherit; background:var(--chrome-bar,#252a39); padding:0 10px; }
    .picker { max-height:240px; overflow:auto; border:1px solid var(--chrome-border,#475067); border-radius:9px; margin:0 0 14px; background:var(--chrome-bar,#252a39); }
    .picker-head { display:flex; align-items:center; gap:8px; padding:8px; border-bottom:1px solid var(--chrome-border,#475067); }
    .picker-head span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .picker button { border:0; color:inherit; background:transparent; padding:6px 10px; border-radius:5px; }
    .picker button:hover { background:var(--chrome-hover); }
    .picker-create { display:flex; gap:6px; padding:8px; border-bottom:1px solid var(--chrome-border,#475067); }
    .picker-create input { flex:1; }
    .folder-entry { display:block; width:100%; text-align:left; }
    .composer { position:relative; display:flex; flex-direction:column; gap:9px; border:1px solid var(--chrome-border,#475067); border-radius:18px; background:var(--chrome-bar,#202632); padding:15px 14px 10px; transition:border-color .15s,box-shadow .15s; }
    .composer:focus-within { border-color:color-mix(in srgb,var(--chrome-accent,#9bb8f7) 58%,var(--chrome-border,#475067)); box-shadow:0 0 0 2px color-mix(in srgb,var(--chrome-accent,#9bb8f7) 14%,transparent); }
    textarea { box-sizing:border-box; display:block; width:100%; min-width:0; min-height:100px; height:100px; max-height:220px; resize:none; border:0; outline:0; padding:3px 0; color:inherit; background:transparent; font:16px/1.55 system-ui,sans-serif; overflow-y:auto; }
    textarea::placeholder { color:var(--chrome-text-dim,#a9b0c0); opacity:.8; }
    .attachments { display:flex; flex-wrap:wrap; gap:8px; }
    .attachment { position:relative; display:flex; align-items:center; gap:9px; min-width:0; max-width:min(100%,230px); padding:5px 28px 5px 5px; border:1px solid var(--chrome-border,#41485f); border-radius:10px; background:var(--chrome-bar,#202632); }
    .attachment img { flex:none; width:52px; height:52px; object-fit:cover; border-radius:6px; background:var(--chrome-body); }
    .attachment .filename { min-width:0; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
    .attachment .status { color:var(--chrome-text-dim,#9aa3b8); font-size:11px; }
    .attachment .status.failed { color:var(--chrome-danger); }
    .attachment button { position:absolute; top:4px; right:4px; width:22px; height:22px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--chrome-text-dim,#9aa3b8); font-size:18px; line-height:20px; }
    .attachment button:hover { background:var(--chrome-hover); color:inherit; }
    .attach-button { flex:none; width:34px; height:34px; display:grid; place-items:center; border:0; border-radius:9px; padding:0; background:transparent; color:var(--chrome-text-bright,#d9def0); }
    .attach-button svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
    .attach-button:hover,.attach-button:focus-visible { background:var(--chrome-hover); outline:none; }
    .file-input { display:none; }
    .drop-overlay { position:absolute; inset:8px; z-index:10; display:grid; place-items:center; border:2px dashed var(--chrome-accent); border-radius:16px; background:color-mix(in srgb, var(--chrome-body) 92%, transparent); color:var(--chrome-text-bright); font-size:22px; pointer-events:none; }
    .send { flex:none; width:34px; height:34px; border:0; border-radius:10px; background:var(--chrome-accent); color:var(--chrome-body); font-size:20px; line-height:1; }
    .send:hover:not(:disabled) { filter:brightness(1.1); }
    .send:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .send:disabled { opacity:.4; cursor:default; }
    .error { margin:10px 0; color:var(--chrome-danger); }
    .setup-shell { max-width:1080px; margin:28px auto 34px; }
    .setup-header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:26px; }
    .setup-header h1 { margin:0 0 8px; font-size:32px; font-weight:650; letter-spacing:-.035em; line-height:1.13; }
    .setup-lead { max-width:620px; margin:0; color:var(--chrome-text-dim); font-size:14px; line-height:1.6; }
    .setup-progress { display:flex; align-items:center; gap:15px; padding:0 0 20px; margin-bottom:24px; border-bottom:1px solid var(--chrome-border); color:var(--chrome-text-dim); font-size:12px; }
    .setup-progress span { display:inline-flex; align-items:center; gap:7px; }
    .setup-progress b { display:grid; place-items:center; width:23px; height:23px; border:1px solid var(--chrome-border); border-radius:50%; font-size:11px; font-weight:600; }
    .setup-progress .current { color:var(--chrome-text-bright); font-weight:600; }
    .setup-progress .current b,.setup-progress .done b { border-color:var(--chrome-accent); background:var(--chrome-accent); color:var(--chrome-body); }
    .setup-progress i { width:30px; height:1px; background:var(--chrome-border); }
    .setup-action { display:inline-flex; align-items:center; justify-content:center; min-height:34px; padding:7px 12px; border:1px solid var(--chrome-border); border-radius:8px; background:var(--chrome-hover); color:var(--chrome-text-bright); font-size:12px; font-weight:550; white-space:nowrap; }
    .setup-action:hover:not(:disabled) { border-color:var(--chrome-accent); }
    .setup-action:focus-visible,.provider-choice:focus-visible,.setup-link:focus-visible { outline:2px solid var(--chrome-accent); outline-offset:2px; }
    .setup-action:disabled { opacity:.5; cursor:default; }
    .setup-action.primary { border-color:var(--chrome-accent); background:var(--chrome-accent); color:var(--chrome-body); font-weight:650; }
    .setup-link { padding:4px 0; border:0; background:transparent; color:var(--chrome-accent); font-size:12px; text-decoration:none; }
    .setup-link:hover { text-decoration:underline; }
    .provider-workspace { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr)); gap:28px; align-items:start; }
    .provider-workspace.compact { grid-template-columns:minmax(0,1fr); gap:14px; }
    .provider-picker { display:flex; align-items:center; gap:12px; color:var(--chrome-text-dim); font-size:12px; }
    .provider-picker select { width:min(100%,280px); height:34px; }
    .provider-browser { border-top:1px solid var(--chrome-border); }
    .provider-choice { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 12px; align-items:center; width:100%; padding:15px 12px 15px 14px; border:0; border-bottom:1px solid var(--chrome-border); border-left:3px solid transparent; border-radius:0; background:transparent; color:var(--chrome-text-bright); text-align:left; }
    .provider-choice:hover { background:color-mix(in srgb,var(--chrome-accent) 5%,var(--chrome-body)); }
    .provider-choice[aria-pressed="true"] { border-left-color:var(--chrome-accent); background:color-mix(in srgb,var(--chrome-accent) 8%,var(--chrome-body)); }
    .provider-choice strong { font-size:14px; font-weight:620; }
    .provider-choice .detail { grid-column:1; color:var(--chrome-text-dim); font-size:12px; line-height:1.4; }
    .provider-choice .provider-status { grid-column:2; grid-row:1 / 3; max-width:115px; color:var(--chrome-text-dim); font-size:11px; line-height:1.3; text-align:right; }
    .provider-choice .provider-status.active { color:var(--chrome-accent); font-weight:650; }
    .provider-setup { box-sizing:border-box; min-height:365px; padding:22px 24px; border:1px solid var(--chrome-border); border-radius:12px; background:var(--chrome-bar); }
    .provider-setup h2 { margin:0 0 5px; font-size:20px; font-weight:650; letter-spacing:-.02em; }
    .provider-setup p { max-width:58ch; margin:5px 0 12px; color:var(--chrome-text-dim); font-size:12px; line-height:1.55; }
    .provider-setup .provider-note { margin:0 0 13px; }
    .provider-setup .default-note { padding:9px 11px; border-left:2px solid var(--chrome-accent); background:var(--chrome-body); }
    .setup-sequence { margin-top:20px; border-top:1px solid var(--chrome-border); }
    .sequence-row { display:grid; grid-template-columns:22px minmax(0,1fr) auto; gap:12px; align-items:center; min-height:58px; padding:11px 0; border-bottom:1px solid var(--chrome-border); }
    .sequence-row .number { color:var(--chrome-text-dim); font:12px ui-monospace,SFMono-Regular,monospace; }
    .sequence-row strong { display:block; font-size:13px; font-weight:600; }
    .sequence-row small { display:block; margin-top:2px; color:var(--chrome-text-dim); font-size:11px; line-height:1.4; }
    .sequence-row .setup-status { text-align:right; }
    .provider-tools { display:flex; flex-wrap:wrap; gap:14px; align-items:center; margin-top:15px; }
    .provider-tools a { color:var(--chrome-accent); font-size:12px; text-decoration:none; }
    .provider-tools a:hover { text-decoration:underline; }
    .setup-status { color:var(--chrome-text-dim); font-size:11px; }
    .setup-status.ready { color:var(--chrome-accent); font-weight:650; }
    .setup-footer { display:flex; flex-wrap:wrap; align-items:center; gap:14px; margin-top:24px; padding-top:17px; border-top:1px solid var(--chrome-border); }
    .setup-footer .next { margin-left:auto; }
    .setup-footer .hint { color:var(--chrome-text-dim); font-size:11px; }
    .setup-list { display:flex; flex-direction:column; border-top:1px solid var(--chrome-border); }
    .setup-card { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px 20px; align-items:center; padding:17px 4px; border-bottom:1px solid var(--chrome-border); }
    .setup-card-heading { display:flex; align-items:baseline; gap:12px; }
    .setup-card h2 { margin:0; font-size:15px; font-weight:620; }
    .setup-card p { max-width:70ch; margin:4px 0 0; color:var(--chrome-text-dim); font-size:12px; line-height:1.45; }
    .setup-card .setup-actions { display:flex; align-items:center; gap:12px; margin:0; }
    .setup-card .setup-actions a { color:var(--chrome-accent); font-size:12px; text-decoration:none; white-space:nowrap; }
    .setup-card .setup-actions a:hover { text-decoration:underline; }
    .setup-card details { margin-top:5px; color:var(--chrome-text-dim); font-size:11px; }
    .setup-card details summary { width:fit-content; cursor:pointer; }
    .setup-card code { display:block; max-width:70ch; margin-top:5px; overflow-wrap:anywhere; color:var(--chrome-text-bright); font:11px/1.5 ui-monospace,SFMono-Regular,monospace; }
    .layout.with-utility .setup-header h1 { font-size:28px; }
    .layout.with-utility .setup-card { grid-template-columns:1fr; }
    .layout.with-utility .setup-card .setup-actions { justify-content:flex-start; }
    @media(max-width:860px) { .setup-shell { margin-top:10px; } .setup-header h1 { font-size:27px; } .setup-card { grid-template-columns:1fr; } .setup-card .setup-actions { justify-content:flex-start; } }
    @media(max-width:560px) { .provider-setup { padding:17px; } .sequence-row { grid-template-columns:18px minmax(0,1fr); } .sequence-row > :last-child { grid-column:2; justify-self:start; } .setup-header { gap:10px; } .setup-header .setup-action { padding:5px 7px; white-space:normal; } }
    .receipt { display:flex; align-items:center; gap:8px; margin:12px 2px 0; color:var(--chrome-text-dim,#a9b0c0); font-size:12px; }
    .receipt::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--chrome-accent,#9bb8f7); animation:receipt-pulse 1.35s ease-in-out infinite; }
    @keyframes receipt-pulse { 50% { opacity:.35; transform:scale(.7); } }
    @media (prefers-reduced-motion:reduce) { .receipt::before { animation:none; } }
    .location-settings { position:relative; min-width:0; }
    .location-settings summary { display:flex; align-items:center; gap:6px; box-sizing:border-box; max-width:230px; height:31px; padding:0 9px; border:1px solid var(--chrome-border,#475067); border-radius:8px; cursor:pointer; color:var(--chrome-text-bright,#e2e6f1); font-size:12px; white-space:nowrap; list-style:none; }
    .location-settings .folder-symbol { display:flex; flex:none; color:var(--chrome-accent,#9bb8f7); }
    .location-settings .folder-label { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .location-settings summary::-webkit-details-marker { display:none; }
    .location-settings summary:hover,.location-settings[open] summary { border-color:var(--chrome-accent,#9bb8f7); }
    .location-fields { position:absolute; z-index:20; top:37px; left:0; display:grid; gap:9px; box-sizing:border-box; width:min(400px,calc(100vw - 72px)); max-height:300px; overflow:auto; padding:11px; border:1px solid var(--chrome-border,#475067); border-radius:10px; background:var(--chrome-bar,#252a39); box-shadow:0 12px 30px #0009; }
    .location-note { margin:0; color:var(--chrome-text-dim,#a9b0c0); font-size:11px; }
    @media(max-width:700px) { .utility-drawer { position:absolute; z-index:5; inset:0 0 0 auto; width:min(100%,580px); min-width:0; box-shadow:-12px 0 35px #0005; } .main { padding:16px; } h1 { font-size:24px; } .controls { gap:6px; } .controls select { max-width:125px; } .project-trigger { max-width:135px; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('dragover', this.preventFileNavigation);
    window.addEventListener('drop', this.preventFileNavigation);
    window.addEventListener('drop', this.resetDrop);
    window.addEventListener('dragend', this.resetDrop);
    this.harness = this.initialHarness;
    void this.loadOnboarding();
    if (this.initialPrompt) this.prompt = this.initialPrompt;
    void this.loadStartOptions();
    void this.loadAmplifierProviderSetup();
    this.optionsRefreshTimer = window.setInterval(() => {
      if (this.firstRun || (this.utilityOpen && this.startOptions?.length === 0)) void this.loadStartOptions(true);
      if (this.firstRun || this.providerSettingsOpen) void this.loadAmplifierProviderSetup();
    }, 4000);
    if (this.initialFolder) this.folder = this.initialFolder;
    if (this.initialProject) this.projectId = this.initialProject;
    document.addEventListener('pointerdown', this.closeDropdowns);
    this.unsub = sdkChats.subscribe(() => this.requestUpdate());
    void sdkChats.refresh().then(() => { const project = sdkChats.projects.find(p => p.id === this.projectId); if (project) this.folder = project.path; }).catch(error => { this.error = String(error); });
    void sdkChats.folders().then(listing => { this.listing = listing; if (!this.folder) this.folder = listing.base; }).catch(error => { this.error = String(error); });
  }
  override disconnectedCallback() {
    this.unsub?.();
    if (this.optionsRefreshTimer) window.clearInterval(this.optionsRefreshTimer);
    document.removeEventListener('pointerdown', this.closeDropdowns);
    window.removeEventListener('dragover', this.preventFileNavigation);
    window.removeEventListener('drop', this.preventFileNavigation);
    window.removeEventListener('drop', this.resetDrop);
    window.removeEventListener('dragend', this.resetDrop);
    for (const item of this.attachments) if (item.preview) URL.revokeObjectURL(item.preview);
    super.disconnectedCallback();
  }
  override firstUpdated() { this.shadowRoot?.querySelector('textarea')?.focus(); }
  override updated(changed: Map<string, unknown>) { if (changed.has('prompt')) this.sizeTextarea(); }
  private sizeTextarea() {
    const textarea = this.shadowRoot?.querySelector('textarea');
    if (!textarea) return;
    textarea.style.height = '100px';
    textarea.style.height = `${Math.min(220, Math.max(100, textarea.scrollHeight))}px`;
  }
  private async browse(path = this.folder) {
    try { this.listing = await sdkChats.folders(path); if (this.listing.path === path) { this.folder = this.listing.path; this.onFolderChanged(); } this.pickerOpen = true; this.error = ''; }
    catch (error) { this.error = String(error); }
  }
  private onFolderChanged() {
    const selected = sdkChats.projects.find(p => p.id === this.projectId);
    if (selected && selected.path !== this.folder) this.projectId = 'new';
  }
  private locationLabel() {
    if (!this.folder) return 'Choose a folder';
    const clean = (path: string) => {
      if (!path.startsWith('/')) return path;
      const parts: string[] = [];
      for (const part of path.split('/')) {
        if (part === '..') parts.pop();
        else if (part && part !== '.') parts.push(part);
      }
      return `/${parts.join('/')}`;
    };
    const folder = clean(this.folder);
    const base = this.listing?.base ? clean(this.listing.base) : '';
    if (base && folder === base) return base.split('/').filter(Boolean).at(-1) || '/';
    if (base && folder.startsWith(base === '/' ? '/' : `${base}/`)) return folder.slice(base === '/' ? 1 : base.length + 1);
    return folder;
  }
  private onProjectChange(value: string) {
    this.projectId = value;
    this.projectPickerOpen = false;
    if (value === 'new') this.locationOpen = true;
    const project = sdkChats.projects.find(p => p.id === value);
    if (project) this.folder = project.path;
    else if (value === 'ungrouped' && this.listing) this.folder = this.listing.base;
    if (value === 'ungrouped' || value === 'new') this.workMode = 'local';
  }
  private onHarnessChange(value: SDKHarnessName) {
    const option = this.startOptions?.find(item => item.harness === value);
    if (!option) return;
    this.harness = option.harness;
    this.provider = option.provider;
  }
  private async loadStartOptions(silent = false) {
    if (this.optionsRefreshing) return;
    this.optionsRefreshing = true;
    if (!silent) this.optionsLoaded = false;
    try {
      const response = await fetch(apiPath('/api/sdk-chat-start-options'));
      if (!response.ok) throw new Error(await response.text());
      const options = await response.json() as StartOption[];
      if (!this.isConnected) return;
      this.startOptions = options;
      const selected = options.find(item => item.harness === this.harness && item.provider === this.provider)
        || options.find(item => item.harness === this.initialHarness) || options[0];
      if (selected && (selected.harness !== this.harness || selected.provider !== this.provider)) this.onHarnessChange(selected.harness);
      else this.error = '';
    } catch (error) {
      if (this.isConnected && (!silent || !this.startOptions)) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.optionsRefreshing = false;
      if (this.isConnected && !silent) this.optionsLoaded = true;
    }
  }
  private async loadAmplifierProviderSetup() {
    try {
      const response = await fetch(apiPath('/api/amplifier-provider-setup'));
      if (!response.ok) throw new Error(await response.text());
      const setup = await response.json() as AmplifierProviderSetup;
      if (!this.isConnected) return;
      this.amplifierProviderSetup = setup;
      if (!this.chosenAIProvider) this.chosenAIProvider = setup.providers.find(provider => provider.source)?.id || 'anthropic';
      this.providerError = '';
    } catch (error) {
      if (this.isConnected) this.providerError = error instanceof Error ? error.message : String(error);
    }
  }
  private async checkAIProvider() {
    if (this.providerCheckBusy || !this.amplifierProviderSetup?.cliInstalled) return;
    const provider = this.chosenAIProvider;
    this.providerCheckBusy = true;
    this.providerCheckError = '';
    this.providerChecked = '';
    try {
      const response = await fetch(apiPath('/api/amplifier-provider-setup/check'), {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({provider}),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || 'Could not check provider.');
      if (this.isConnected && this.chosenAIProvider === provider) {
        this.providerChecked = provider;
        await this.loadAmplifierProviderSetup();
      }
    } catch (error) {
      if (this.isConnected && this.chosenAIProvider === provider) this.providerCheckError = error instanceof Error ? error.message : String(error);
    } finally { this.providerCheckBusy = false; }
  }
  private chooseAIProvider(provider: string) {
    this.chosenAIProvider = provider;
    this.providerError = '';
    this.providerChecked = '';
    this.providerCheckError = '';
  }
  private renderProviderSetup(): TemplateResult {
    const setup = this.amplifierProviderSetup;
    const selected = setup?.providers.find(provider => provider.id === this.chosenAIProvider);
    const name = AI_PROVIDERS.find(provider => provider.id === this.chosenAIProvider)?.name || 'Provider';
    const connected = this.providerChecked === this.chosenAIProvider;
    return this.renderScreen(html`<div class="main setup"><div class="content setup-shell">
      <header class="setup-header"><div><h1>${this.firstRun ? 'Connect an AI provider' : 'Amplifier provider'}</h1><p class="setup-lead">Amplifier uses this connection for its chats. Choose a service, then confirm it can reach a model.</p></div></header>
      ${this.firstRun ? html`<nav class="setup-progress" aria-label="Setup progress"><span class="current" aria-current="step"><b>1</b>AI provider</span><i aria-hidden="true"></i><span><b>2</b>Coding agents</span></nav>` : nothing}
      <div class="provider-workspace ${this.utilityOpen ? 'compact' : ''}">
        ${this.utilityOpen ? html`<label class="provider-picker">Provider<select aria-label="AI provider" .value=${this.chosenAIProvider} @change=${(event:Event) => this.chooseAIProvider((event.target as HTMLSelectElement).value)}>${AI_PROVIDERS.map(provider => html`<option value=${provider.id}>${provider.name}</option>`)}</select></label>` : html`<section class="provider-browser" aria-label="AI providers">${AI_PROVIDERS.map(provider => {
          const state = setup?.providers.find(item => item.id === provider.id);
          const isDefault = setup?.primary === provider.id;
          const status = isDefault ? 'Default' : state?.source === 'environment' || state?.source === 'amplifier-keys' ? 'Key found' : state?.source === 'oauth-cache' ? 'Sign-in found' : 'Set up';
          return html`<button class="provider-choice" aria-pressed=${this.chosenAIProvider === provider.id} @click=${() => this.chooseAIProvider(provider.id)}><strong>${provider.name}</strong><span class="detail">${provider.detail}</span><span class="provider-status ${isDefault ? 'active' : ''}">${status}</span></button>`;
        })}</section>`}
        <section class="provider-setup" aria-label=${`${name} setup`}>
          <h2>${name}</h2>
          ${!setup ? html`<p role="status">Checking Amplifier on this computer…</p>` : html`
            <p class="provider-note">${connected ? 'Amplifier reached this provider.' : selected?.source === 'environment' ? `${selected.envName} is available in Muxterm’s environment.` : selected?.source === 'amplifier-keys' ? `${selected.envName} is in ~/.amplifier/keys.env. Amplifier can reuse it.` : selected?.source === 'oauth-cache' ? 'A previous ChatGPT sign-in was found.' : 'Complete setup in the terminal to connect this service.'}</p>
            <p class="default-note">${setup.primary ? setup.primary === this.chosenAIProvider ? `${name} is your default provider.` : `Current default: ${AI_PROVIDERS.find(provider => provider.id === setup.primary)?.name || setup.primary}. To make ${name} the default, open Manage providers, choose Reorder priorities (p), and move it to first.` : 'The first provider you configure becomes the default. To change it later, use Manage providers → Reorder priorities (p).'}</p>
            <div class="setup-sequence">
              <div class="sequence-row"><span class="number">1</span><div><strong>Amplifier</strong><small>${setup.cliInstalled ? 'Installed on this computer' : 'Required for Amplifier chats'}</small></div>${setup.cliInstalled ? html`<span class="setup-status ready">Installed</span>` : html`<button class="setup-action" @click=${() => void this.openTerminal('Install Amplifier', SETUP_AGENTS.find(agent => agent.harness === 'amplifier')!.command)}>Install</button>`}</div>
              <div class="sequence-row"><span class="number">2</span><div><strong>Configure ${name}</strong><small>${setup.primary === this.chosenAIProvider ? 'Selected as Amplifier’s default' : 'Choose a model and sign in, if needed'}</small></div><button class="setup-action" ?disabled=${!setup.cliInstalled} @click=${() => void this.openTerminal('Amplifier provider setup', `export PATH="$HOME/.local/bin:$PATH"; amplifier provider add ${this.chosenAIProvider} --scope global`)}>Configure</button></div>
              <div class="sequence-row"><span class="number">3</span><div><strong>Check connection</strong><small>${connected ? 'A model is available' : 'Ask Amplifier to list available models'}</small></div>${connected ? html`<span class="setup-status ready" role="status">Connected</span>` : html`<button class="setup-action" ?disabled=${!setup.cliInstalled || this.providerCheckBusy} @click=${() => void this.checkAIProvider()}>${this.providerCheckBusy ? 'Checking…' : 'Check'}</button>`}</div>
            </div>
            <div class="provider-tools"><button class="setup-link" ?disabled=${!setup.cliInstalled} @click=${() => void this.openTerminal('Amplifier providers', 'export PATH="$HOME/.local/bin:$PATH"; amplifier provider manage')}>Manage providers</button><button class="setup-link" ?disabled=${!setup.cliInstalled} @click=${() => void this.openTerminal('Amplifier setup', 'export PATH="$HOME/.local/bin:$PATH"; amplifier init')}>Open full setup</button><a href="https://github.com/microsoft/amplifier/blob/main/docs/USER_ONBOARDING.md" target="_blank" rel="noopener noreferrer">Setup guide</a></div>
            ${this.providerCheckError ? html`<p class="error" role="alert">${this.providerCheckError}</p>` : nothing}
          `}
          ${this.providerError ? html`<p class="error" role="alert">${this.providerError}</p>` : nothing}
        </section>
      </div>
      <footer class="setup-footer"><button class="setup-link" @click=${() => void this.loadAmplifierProviderSetup()}>Refresh status</button><span class="hint">A saved key needs a successful connection check.</span>${this.firstRun ? html`<button class="setup-action primary next" ?disabled=${!connected || (!!setup?.primary && setup.primary !== this.chosenAIProvider)} @click=${() => { this.setupStep = 'harness'; }}>Continue to coding agents</button>` : html`<button class="setup-action primary next" @click=${() => { this.providerSettingsOpen = false; }}>Back to new chat</button>`}</footer>
    </div></div>`);
  }
  private async openTerminal(label?: string, command?: string) {
    if (!this.folder) { this.error = 'Choose a folder before opening a terminal.'; return; }
    this.terminalRequested = true;
    this.utilityOpen = true;
    await this.updateComplete;
    const utility = this.shadowRoot?.querySelector<MuxSDKUtility>('mux-sdk-utility');
    if (!utility) return;
    if (label && command) utility.openSetupTerminal(label, command);
    else utility.showPanel('terminal');
  }
  private renderScreen(content: TemplateResult): TemplateResult {
    return html`<div class="layout ${this.utilityOpen ? 'with-utility' : ''}">${content}${this.utilityOpen ? html`<aside class="utility-drawer" aria-label="Setup tools"><header><span>Tools · terminals stay with your chat</span><button aria-label="Close tools" @click=${() => { this.utilityOpen = false; }}>Close</button></header><mux-sdk-utility .sessionId=${this.draftId} .projectPath=${this.folder} .chatTitle=${'Setup'} .terminalWorkspaceId=${this.terminalWorkspaceId}></mux-sdk-utility></aside>` : nothing}</div>`;
  }
  private async loadOnboarding() {
    try {
      const response = await fetch(apiPath('/api/sdk-chat-onboarding'));
      if (!response.ok) throw new Error(await response.text());
      const state = await response.json() as { complete: boolean };
      if (this.isConnected) {
        this.firstRun = !state.complete; this.onboardingError = '';
        this.dispatchEvent(new CustomEvent('onboarding-state', { detail:{firstRun:this.firstRun}, bubbles:true, composed:true }));
      }
    } catch (error) {
      if (this.isConnected) {
        this.onboardingError = (error instanceof Error ? error.message : String(error)) || 'Could not check onboarding state.';
        this.dispatchEvent(new CustomEvent('onboarding-state', { detail:{firstRun:false}, bubbles:true, composed:true }));
      }
    } finally {
      if (this.isConnected) this.onboardingLoaded = true;
    }
  }
  private async finishFirstRun() {
    try {
      const response = await fetch(apiPath('/api/sdk-chat-onboarding'), { method:'POST' });
      if (!response.ok) throw new Error(await response.text());
      if (this.isConnected) {
        this.firstRun = false;
        this.dispatchEvent(new CustomEvent('onboarding-state', { detail:{firstRun:false}, bubbles:true, composed:true }));
      }
    } catch (error) {
      if (this.isConnected) this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private onDragEnter(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); this.dragDepth++; this.dropActive = true; }
  private onDragOver(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; this.dropActive = true; }
  private onDragLeave(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); this.dragDepth = Math.max(0, this.dragDepth - 1); if (!this.dragDepth) this.dropActive = false; }
  private onDrop(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); event.stopPropagation(); this.resetDrop(); this.addFiles(Array.from(event.dataTransfer?.files || [])); }
  private onPick(event: Event) { const input = event.target as HTMLInputElement; this.addFiles(Array.from(input.files || [])); input.value = ''; }
  private onPaste(event: ClipboardEvent) {
    const images = Array.from(event.clipboardData?.items || [])
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile()).filter((file): file is File => file !== null);
    if (!images.length) return;
    event.preventDefault();
    this.addFiles(images.map((file, index) => new File([file],
      `Pasted image ${new Date().toISOString().replace(/[:.]/g, '-')}${images.length > 1 ? `-${index + 1}` : ''}.${file.type.split('/')[1] || 'png'}`,
      { type: file.type })));
  }
  private addFiles(files: File[]) {
    for (const file of files) {
      const item: Attachment = { localId:crypto.randomUUID(), file, preview:file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined, uploading:true };
      this.attachments = [...this.attachments, item];
      void this.upload(item);
    }
  }
  private async upload(item: Attachment) {
    const form = new FormData(); form.append('file', item.file);
    try {
      const response = await fetch(apiPath('/api/sdk-chat-attachments'), { method:'POST', headers:{'X-Muxterm-Chat-Attachment':'1'}, body:form });
      const body = await response.text();
      let payload: { id?: string; kind?: string; reason?: string } = {};
      try { payload = JSON.parse(body) as typeof payload; } catch { /* Preserve server text for errors. */ }
      if (!response.ok) throw new Error(payload.reason || body.trim() || `Upload failed (${response.status})`);
      if (!payload.id || !payload.kind) throw new Error('Upload response lacked attachment details');
      if (!this.attachments.some(a => a.localId === item.localId)) return;
      if (payload.kind !== 'image' && item.preview) URL.revokeObjectURL(item.preview);
      this.attachments = this.attachments.map(a => a.localId === item.localId
        ? { ...a, id:payload.id, kind:payload.kind, preview:payload.kind === 'image' ? item.preview : undefined, uploading:false } : a);
    } catch (error) {
      if (!this.attachments.some(a => a.localId === item.localId)) return;
      this.attachments = this.attachments.map(a => a.localId === item.localId
        ? { ...a, uploading:false, error:error instanceof Error ? error.message : String(error) } : a);
    }
  }
  private removeAttachment(localId: string) {
    const item = this.attachments.find(a => a.localId === localId);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    this.attachments = this.attachments.filter(a => a.localId !== localId);
  }
  private async send() {
    const prompt = this.prompt.trim();
    if (this.terminalRequested && !this.terminalWorkspaceId) { this.error = 'Wait for the setup terminal to open before starting the chat.'; return; }
    if ((!prompt && !this.attachments.length) || this.busy || !this.startOptions?.some(item => item.harness === this.harness && item.provider === this.provider) || this.attachments.some(a => a.uploading || a.error)) return;
    this.busy = true; this.error = '';
    try {
      await this.updateComplete;
      let workspaceId: string | undefined;
      if (this.projectId === 'new') {
        if (!this.folder.startsWith('/')) throw new Error('Choose an absolute folder for the new project.');
        workspaceId = (await sdkChats.createProject(this.folder, this.projectName.trim())).id;
      } else if (this.projectId !== 'ungrouped') workspaceId = this.projectId;
      const chat = await sdkChats.create({ workspaceId, terminalWorkspaceId:this.terminalWorkspaceId || undefined, projectPath:this.folder, workMode:this.workMode, harness:this.harness, provider:this.provider, prompt, attachments:this.attachments.map(a => a.id!) });
      carryUtilityTabs(this.draftId, chat.id);
      this.dispatchEvent(new CustomEvent('chat-created', { detail:{sessionId:chat.id}, bubbles:true, composed:true }));
    } catch (error) { this.error = error instanceof Error ? error.message.trim() : String(error); }
    finally { this.busy = false; }
  }
  override render() {
    const selectedProject = sdkChats.projects.find(project => project.id === this.projectId);
    if (!this.onboardingLoaded || (this.firstRun && this.setupStep === 'harness' && !this.optionsLoaded)) return this.renderScreen(html`<div class="main setup"><div class="content setup-shell"><h1>Welcome to Muxterm</h1><p class="setup-lead" role="status">Checking your coding agents…</p></div></div>`);
    if (this.onboardingError) return this.renderScreen(html`<div class="main setup"><div class="content setup-shell"><h1>Welcome to Muxterm</h1><p class="error" role="alert">${this.onboardingError}</p><button class="setup-action" @click=${() => void this.loadOnboarding()}>Try again</button></div></div>`);
    if ((this.firstRun && this.setupStep === 'provider') || this.providerSettingsOpen) return this.renderProviderSetup();
    if (this.firstRun && !this.startOptions) return this.renderScreen(html`<div class="main setup"><div class="content setup-shell"><h1>Welcome to Muxterm</h1><p class="error" role="alert">${this.error || 'Could not check coding agents.'}</p><button class="setup-action" @click=${() => void this.loadStartOptions()}>Try again</button></div></div>`);
    const showFirstRun = this.firstRun;
    if (this.startOptions && (showFirstRun || this.startOptions.length === 0)) return this.renderScreen(html`
      <div class="main setup"><div class="content setup-shell">
        <header class="setup-header"><div><h1>${showFirstRun ? 'Choose your coding agents' : 'Connect a coding agent'}</h1><p class="setup-lead">Install or sign in to the agents you want to use. Setup opens in a terminal beside this screen.</p></div></header>
        ${showFirstRun ? html`<nav class="setup-progress" aria-label="Setup progress"><span class="done"><b>✓</b>AI provider</span><i aria-hidden="true"></i><span class="current" aria-current="step"><b>2</b>Coding agents</span></nav>` : nothing}
        <p class="setup-lead">${this.startOptions.length} of ${SETUP_AGENTS.length} agents found. <strong>Ready</strong> means Muxterm can start a chat. <strong>Detected</strong> means an ACP command exists; sign-in still needs confirmation.</p>
        <div class="setup-list">${SETUP_AGENTS.map(agent => {
          const found = this.startOptions!.some(option => option.harness === agent.harness);
          const acp = agent.harness === 'opencode' || agent.harness === 'pi' || agent.harness === 'deepseek';
          const status = found ? acp ? 'Detected' : 'Ready' : agent.harness === 'codex' || agent.harness === 'claude' ? 'Sign-in needed' : 'Needs setup';
          const detail = found ? acp ? 'Command found. Sign in before the first chat.' : agent.harness === 'amplifier' ? 'Ready for Amplifier chats.' : 'Ready for new chats.' : agent.harness === 'codex' || agent.harness === 'claude' ? 'The SDK is included. Sign in with the CLI to use your account.' : agent.harness === 'amplifier' ? 'Install Amplifier, then configure a provider.' : 'Install the command and connect its account.';
          return html`<section class="setup-card"><div><div class="setup-card-heading"><h2>${agent.name}</h2><span class="setup-status ${found && !acp ? 'ready' : ''}">${status}</span></div><p>${detail}</p>${!found ? html`<details><summary>Show install command</summary><code>${agent.command}</code></details>` : nothing}</div><div class="setup-actions">${found && !acp ? nothing : html`<button class="setup-action" @click=${() => void this.openTerminal(`${agent.name} setup`, found ? agent.login : `${agent.command} && ${agent.login}`)}>${found ? 'Open sign-in terminal' : 'Install and sign in'}</button>`}<a href=${agent.docs} target="_blank" rel="noopener noreferrer">Setup guide</a></div></section>`;
        })}</div>
        <footer class="setup-footer">${showFirstRun ? html`<button class="setup-link" @click=${() => { this.setupStep = 'provider'; }}>Back to provider</button>` : nothing}<button class="setup-link" @click=${() => void this.loadStartOptions()}>Refresh status</button><span class="hint">Checks refresh automatically while setup is open.</span>${showFirstRun && this.startOptions.length ? html`<button class="setup-action primary next" @click=${this.finishFirstRun}>Start using Muxterm</button>` : nothing}</footer>
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      </div></div>`);
    return this.renderScreen(html`
    <div class="main"><div class="content">
      <div class="composer-tools"><button @click=${() => { this.providerSettingsOpen = true; void this.loadAmplifierProviderSetup(); }}>AI provider</button><button @click=${() => void this.openTerminal()}>Tools</button></div>
      <h1>What would you like to do?</h1>
      <div class="composer" @paste=${this.onPaste} @dragenter=${this.onDragEnter} @dragover=${this.onDragOver} @dragleave=${this.onDragLeave} @drop=${this.onDrop}>
        <div class="controls">
        <div class="project"><div class="project-picker"><button class="project-trigger" role="combobox" aria-label="Project" aria-expanded=${this.projectPickerOpen} aria-controls="project-options" @click=${() => { this.projectPickerOpen = !this.projectPickerOpen; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Escape') this.projectPickerOpen = false; if (e.key === 'ArrowDown') this.projectPickerOpen = true; }}><span class="project-symbol">${icon(this.projectId === 'new' ? Plus : Folder,{size:15})}</span><span class="project-name">${selectedProject?.name || (this.projectId === 'new' ? 'New project' : 'Ungrouped')}</span><span class="down">${icon(ChevronDown,{size:16})}</span></button>
          ${this.projectPickerOpen ? html`<div id="project-options" class="project-options" role="listbox" aria-label="Projects">
            <button class="project-option" role="option" aria-selected=${this.projectId === 'ungrouped'} ?selected=${this.projectId === 'ungrouped'} @click=${() => this.onProjectChange('ungrouped')}>${icon(Folder,{size:16})}<span class="option-copy"><strong>Ungrouped</strong><small>Choose a folder for this chat</small></span></button>
            ${sdkChats.projects.map(p => html`<button class="project-option" role="option" aria-selected=${this.projectId === p.id} ?selected=${this.projectId === p.id} title=${p.path} @click=${() => this.onProjectChange(p.id)}>${icon(Folder,{size:16})}<span class="option-copy"><strong>${p.name}</strong><small>${p.path}</small></span></button>`)}
            <div class="project-divider"></div><button class="project-option" role="option" aria-selected=${this.projectId === 'new'} ?selected=${this.projectId === 'new'} @click=${() => this.onProjectChange('new')}>${icon(Plus,{size:16})}<span class="option-copy"><strong>New project</strong><small>Choose its primary folder</small></span></button>
          </div>` : nothing}
        </div></div>
        <details class="location-settings" ?open=${this.locationOpen} @toggle=${(e: Event) => { this.locationOpen = (e.target as HTMLDetailsElement).open; }}><summary title=${this.folder}><span class="folder-symbol">${icon(Folder,{size:14})}</span><span class="folder-label">${this.locationLabel()}</span></summary>
          <div class="location-fields">
            <label class="folder">${this.projectId === 'ungrouped' ? 'Folder' : 'Primary folder'}<div class="folder-line"><input aria-label="Primary folder" .value=${this.folder} ?readonly=${this.projectId !== 'ungrouped' && this.projectId !== 'new'} @input=${(e:Event) => { this.folder = (e.target as HTMLInputElement).value; this.onFolderChanged(); }}>${this.projectId === 'ungrouped' || this.projectId === 'new' ? html`<button class="browse" aria-label="Browse server folders" @click=${() => void this.browse()}>Browse</button>` : nothing}</div></label>
            ${this.projectId === 'new' ? html`<label>Project name <input aria-label="Project name" placeholder="Defaults to the folder name" .value=${this.projectName} @input=${(e:Event) => { this.projectName = (e.target as HTMLInputElement).value; }}></label>` : nothing}
            ${this.pickerOpen && this.listing ? html`<div class="picker" aria-label="Server folder picker"><div class="picker-head"><button aria-label="Parent folder" @click=${() => void this.browse(this.listing!.parent)}>↑</button><span>${this.listing.path}</span><button @click=${() => { this.pickerOpen = false; }}>Choose this folder</button></div><div class="picker-create"><input aria-label="New folder name" placeholder="New folder name" .value=${this.newFolderName} @input=${(e:Event) => { this.newFolderName = (e.target as HTMLInputElement).value; }}><button @click=${() => { if (!this.newFolderName.trim() || this.newFolderName.includes('/')) return; this.folder = `${this.listing!.path.replace(/\/$/,'')}/${this.newFolderName.trim()}`; this.onFolderChanged(); this.pickerOpen = false; }}>Use new folder</button></div>${this.listing.folders.map(name => html`<button class="folder-entry" @click=${() => void this.browse(`${this.listing!.path.replace(/\/$/,'')}/${name}`)}>▸ ${name}</button>`)}</div>` : nothing}
            <p class="location-note">${this.workMode === 'worktree' ? 'A separate Git worktree will be created from this project’s primary folder.' : this.projectId === 'ungrouped' ? 'This chat will use the chosen folder.' : 'This chat will use the project’s primary folder.'}${selectedProject?.sourceFolders?.length ? ` ${selectedProject.sourceFolders.length} additional source ${selectedProject.sourceFolders.length === 1 ? 'folder is' : 'folders are'} available at their existing paths.` : ''}</p>
          </div>
        </details>
        ${this.startOptions?.length ? html`<label class="harness"><select aria-label="Harness" .value=${this.harness} @change=${(e:Event) => this.onHarnessChange((e.target as HTMLSelectElement).value as SDKHarnessName)}>${this.startOptions.map(option => html`<option value=${option.harness} ?selected=${this.harness === option.harness}>${sdkHarnessLabel(option.harness)}</option>`)}</select></label>` : nothing}
        <button class="worktree-toggle" type="button" role="switch" aria-label="Use a separate Git worktree" aria-checked=${this.workMode === 'worktree'} title=${this.projectId === 'ungrouped' || this.projectId === 'new' ? 'Choose an existing project to use a worktree' : 'Start this chat in a separate Git worktree'} ?disabled=${this.projectId === 'ungrouped' || this.projectId === 'new'} @click=${() => { this.workMode = this.workMode === 'worktree' ? 'local' : 'worktree'; }}><span>Worktree</span><span class="track" aria-hidden="true"><span class="thumb"></span></span></button>
        </div>
        ${this.attachments.length ? html`<div class="attachments" aria-label="Attached files">${this.attachments.map(a => html`<div class="attachment">${a.preview ? html`<img src=${a.preview} alt="">` : nothing}<span class="filename">${a.file.name}</span><span class="status ${a.error ? 'failed' : ''}">${a.error || (a.uploading ? 'Uploading…' : 'Ready')}</span><button aria-label=${`Remove ${a.file.name}`} @click=${() => this.removeAttachment(a.localId)}>×</button></div>`)}</div>` : nothing}
        <textarea aria-label="First message" placeholder="Describe what you want to work on…" .value=${this.prompt} @input=${(e:Event) => { this.prompt = (e.target as HTMLTextAreaElement).value; }} @keydown=${(e:KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); } }}></textarea>
        <div class="composer-actions"><input class="file-input" type="file" multiple aria-label="Choose files to attach" @change=${this.onPick}><button class="attach-button" aria-label="Attach files or images" title="Attach files or images" @click=${() => this.shadowRoot?.querySelector<HTMLInputElement>('.file-input')?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg></button><button class="send" aria-label="Send message" ?disabled=${(!this.prompt.trim() && !this.attachments.length) || this.busy || (this.terminalRequested && !this.terminalWorkspaceId) || !this.startOptions?.some(item => item.harness === this.harness && item.provider === this.provider) || this.attachments.some(a => a.uploading || !!a.error)} @click=${() => void this.send()}>↑</button></div>

        ${this.dropActive ? html`<div class="drop-overlay" role="status">Drop files to attach</div>` : nothing}
      </div>
      ${this.busy ? html`<div class="receipt" role="status">Message received · Creating chat…</div>` : nothing}
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
    </div></div>
  `); }
}
