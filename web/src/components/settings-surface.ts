import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { PALETTES, isLightTheme } from '../lib/theme.js';
import '../ui/button.js';
import '../ui/color-picker.js';
import '../ui/feedback.js';
import type { FeedbackKind } from '../ui/feedback.js';
import '../ui/nav-item.js';
import '../ui/radio-group.js';
import type { MuxUIRangeField } from '../ui/range-field.js';
import '../ui/range-field.js';
import '../ui/select.js';
import '../ui/status-badge.js';
import type { MuxUISelect } from '../ui/select.js';
import type { MuxUITextField } from '../ui/text-field.js';
import '../ui/switch.js';
import '../ui/text-field.js';
import '../ui/theme-choice.js';
import { FONT_FAMILIES } from '../lib/fonts.js';
import type { ResolvedConfig } from '../lib/config.js';
import {
  instanceLabel,
  restoreTitlebarColor,
  persistTitlebarColor,
  applyTitlebarColor,
  DARK_TITLEBAR_CRAYONS,
  LIGHT_TITLEBAR_CRAYONS,
  type TitlebarCrayon,
} from '../lib/instance-identity.js';
import {
  DEFAULT_AI_STATUS,
  saveAIKey,
  clearAIKey,
  pingAI,
  type AIStatus,
} from '../lib/ai.js';
import { apiPath } from '../lib/base-path.js';
import { icon } from '../lib/icons.js';
import { ArrowLeft } from 'lucide';
import geminiMark from '../assets/harness/gemini.svg?url';
import { fetchUpdateStatus, installUpdate, type UpdateStatus } from '../lib/update.js';
import { remotesStore, type HostConnState } from '../lib/remotes-store.js';
import {
  DEFAULT_VOICE_STATUS,
  fetchVoiceStatus,
  saveVoiceSettings,
  clearVoiceKey,
  checkVoice,
  type VoiceStatus,
  type VoiceMode,
} from '../lib/voice-settings.js';

export type SettingsSection = 'appearance' | 'notifications' | 'workspaces' | 'ai' | 'voice' | 'remotes' | 'shortcuts' | 'about';
type GeminiLoginStatus = { state: 'idle' | 'starting' | 'awaiting_code' | 'verifying' | 'complete' | 'error'; url?: string; message?: string };
type GeminiAuth = { mode: 'google' | 'api-key'; apiKeyDetected: boolean };

const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'ai', label: 'AI' },
  { id: 'voice', label: 'Voice' },
  { id: 'remotes', label: 'Remotes' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts' },
  { id: 'about', label: 'About' },
];

// ── Theme card display metadata ──────────────────────────────────────────────

interface ThemeCard {
  id: string;
  label: string;
}

const DARK_THEMES: ThemeCard[] = [
  { id: 'tokyo-night', label: 'Tokyo Night' },
  { id: 'catppuccin',  label: 'Catppuccin'  },
  { id: 'gruvbox',     label: 'Gruvbox'     },
  { id: 'dracula',     label: 'Dracula'     },
  { id: 'nord',        label: 'Nord'        },
];

const LIGHT_THEMES: ThemeCard[] = [
  { id: 'solarized-light', label: 'Solarized' },
  { id: 'one-light',       label: 'One Light' },
  { id: 'github-light',    label: 'GitHub'    },
];

// ── Remotes ──────────────────────────────────────────────────────────────────

/**
 * OpenAI's one and only v1 base URL. The server pins this regardless of what
 * the form sends; the constant exists so the field can SHOW what will be saved
 * rather than sitting empty or, worse, editable and ignored.
 */
const OPENAI_ENDPOINT = 'https://api.openai.com/v1';

/**
 * The status markers. A glyph in a fixed gutter, not a coloured slab: colour
 * only ever reinforces what the glyph and the sentence beside it already say,
 * so nothing here depends on colour vision, a particular palette, or a width
 * wide enough for chrome.
 */
const VOICE_GLYPH: Record<'ok' | 'bad' | 'none', string> = {
  ok: '✓',
  bad: '!',
  none: '·',
};

/** One row of GET /api/remotes, in all three arrays (plan C.0). */
interface RemoteRow {
  /** HostRef.ID, e.g. "ssh:boxb" — the key every other route takes. */
  id: string;
  /** Display label. Never a key. */
  name: string;
  /** Dial target, e.g. "azureuser@20.230.240.43" — the .r-sub line. */
  target: string;
  /** Section heading key (ux D7). */
  transport: string;
  /** Written by muxterm between its own markers, so muxterm may remove it. */
  managed: boolean;
  state: HostConnState;
  probe: 'present' | 'login-shell-only' | 'absent' | 'unknown';
  /** The transport's own failure text, verbatim. Only when unreachable. */
  error?: string;
}

/** GET /api/remotes (plan C.1). All three arrays always present, never null. */
interface RemotesList {
  connected: RemoteRow[];
  discovered: RemoteRow[];
  errors: RemoteRow[];
}

const EMPTY_REMOTES: RemotesList = { connected: [], discovered: [], errors: [] };

/**
 * The Add-a-host request's key in `_pending`. The empty string cannot collide
 * with a host id: remoteRows() drops any row without one.
 */
const ADD_HOST_KEY = '';

/**
 * Section headings for the un-connected half of the pane, keyed by transport
 * (ux D7). A second transport adds a section here and nowhere else — this map
 * is the ONLY part of the UI that knows transports exist. An unmapped
 * transport heads its own section under its own name rather than inventing
 * prose about it.
 */
const TRANSPORT_TITLES: Record<string, string> = {
  ssh: 'From ~/.ssh/config',
};

/**
 * Same order the server sorts each array in (remotes_api.go sortRows): by
 * display name, id breaking ties. Code-unit order, not locale order — host
 * names are machine identifiers and the order must not depend on the browser's
 * locale.
 */
function byNameThenID(a: RemoteRow, b: RemoteRow): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function remoteRows(raw: unknown): RemoteRow[] {
  if (!Array.isArray(raw)) return [];
  const out: RemoteRow[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r['id'] === 'string' ? r['id'] : '';
    if (id === '') continue;
    const row: RemoteRow = {
      id,
      name: typeof r['name'] === 'string' && r['name'] !== '' ? r['name'] : id,
      target: typeof r['target'] === 'string' ? r['target'] : '',
      transport: typeof r['transport'] === 'string' && r['transport'] !== ''
        ? r['transport']
        : 'ssh',
      managed: r['managed'] === true,
      state: r['state'] === 'connected' || r['state'] === 'reconnecting'
        || r['state'] === 'unreachable'
        ? r['state']
        : 'never-connected',
      probe: r['probe'] === 'present' || r['probe'] === 'login-shell-only'
        || r['probe'] === 'absent'
        ? r['probe']
        : 'unknown',
    };
    if (typeof r['error'] === 'string' && r['error'] !== '') row.error = r['error'];
    out.push(row);
  }
  return out;
}

function parseRemotesList(raw: unknown): RemotesList {
  if (raw === null || typeof raw !== 'object') return EMPTY_REMOTES;
  const r = raw as Record<string, unknown>;
  return {
    connected: remoteRows(r['connected']),
    discovered: remoteRows(r['discovered']),
    errors: remoteRows(r['errors']),
  };
}

/**
 * The server's own words for a failed request, verbatim.
 *
 * Every 4xx/5xx body is `{"error": "..."}` and those strings are already
 * written for a human — sshconfig explains the hand-written-Host collision in
 * full sentences, and ssh's "No route to host" is more useful than anything
 * this file could write about it. Paraphrasing loses what the user needs.
 */
async function remoteErrorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const err = body['error'];
    if (typeof err === 'string' && err !== '') return err;
  } catch {
    // Fall through to the status line below.
  }
  return `HTTP ${res.status}`;
}

/**
 * mux-settings-surface — Phase 5 two-column settings panel.
 *
 * Layout: narrow sidebar (Appearance / Notifications) + content area.
 * Changes apply immediately and are persisted via the parent's PATCH call.
 *
 * Events:
 *   config-change  { config: ResolvedConfig }  — emitted on every user change
 *   close                                       — emitted when × is clicked
 */
@customElement('mux-settings-surface')
export class MuxSettingsSurface extends LitElement {
  static styles = css`
    ${subtleScrollbars}
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: var(--ui-surface-base);
      color: var(--ui-text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: var(--ui-text-md);
      box-sizing: border-box;
      overflow: hidden;
    }

    /* ── Header bar ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--ui-space-6) var(--ui-space-7) var(--ui-space-6);
      border-bottom: 1px solid var(--ui-border);
      flex-shrink: 0;
    }

    .header h2 {
      margin: 0;
      font-size: var(--ui-text-xl);
      font-weight: 600;
      color: var(--ui-text);
    }

    :host([page-mode]) .header {
      justify-content: flex-start;
      gap: var(--ui-space-4);
      padding: calc(var(--ui-space-4) + env(safe-area-inset-top, 0)) var(--ui-space-6) var(--ui-space-4);
    }
    :host([page-mode]) .content { padding-bottom: calc(var(--ui-space-10) + env(safe-area-inset-bottom, 0)); }

    /* ── Body: sidebar + content ── */
    .body {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* ── Sidebar ── */
    .sidebar {
      width: var(--ui-settings-sidebar-width);
      flex-shrink: 0;
      border-right: 1px solid var(--ui-border);
      padding: var(--ui-space-5) 0;
      overflow-y: auto;
    }

    /* ── Content area ── */
    .content {
      flex: 1;
      min-width: 0;
      overflow-y: auto;
      overflow-wrap: anywhere;
      padding: var(--ui-space-8) var(--ui-space-9) var(--ui-space-10);
    }

    @media (max-width: 600px) {
      .body { flex-direction: column; }
      .sidebar { display:flex; width:auto; padding:var(--ui-space-4); border-right:0; border-bottom:1px solid var(--ui-border); overflow-x:auto; }
      .content { padding:var(--ui-space-7); }
    }

    /* ── Section headings ── */
    .section-title {
      margin: 0 0 var(--ui-space-6) 0;
      font-size: var(--ui-text-xs);
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ui-text-muted);
    }

    .section-gap {
      margin-top: var(--ui-space-9);
    }

    /* ── Theme card grid ── */
    .theme-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--ui-space-5);
      margin-bottom: var(--ui-space-2);
    }
    .theme-light-heading { margin-top:var(--ui-space-6); }

    /* ── Font size slider ── */
    mux-ui-range-field.font-size { margin-top:var(--ui-space-2); }

    /* ── Font preview line ── */
    .font-preview {
      margin: var(--ui-space-5) 0 0 var(--ui-space-5);
      padding: var(--ui-space-4) var(--ui-space-5);
      background: var(--ui-surface-raised);
      border: 1px solid var(--ui-border);
      border-radius: var(--ui-radius-md);
      font-size: var(--ui-text-sm);
      color: var(--ui-text);
      overflow: hidden;
      white-space: nowrap;
    }

    /* ── Notifications section ── */
    .notif-block {
      max-width: var(--ui-settings-content-width);
    }

    .notif-description {
      color: var(--ui-text-muted);
      line-height: 1.55;
      margin: 0 0 var(--ui-space-6) 0;
    }

    .notif-permission-actions { display:flex; align-items:center; gap:var(--ui-space-5); flex-wrap:wrap; }

    .notif-hint {
      margin-top: var(--ui-space-4);
      font-size: var(--ui-text-sm);
      color: var(--ui-text-muted);
      line-height: 1.5;
    }

    /* ── Theme section label ── */
    .theme-section-label {
      grid-column: 1 / -1;
      font-size: var(--ui-text-xs);
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--ui-text-muted);
      padding-top: var(--ui-space-4);
    }

    .divider {
      height: var(--ui-divider-thickness);
      background: var(--ui-border);
      margin: var(--ui-space-8) 0;
    }

    .titlebar-hint {
      font-size: var(--ui-text-sm);
      color: var(--ui-text-muted);
      margin: var(--ui-space-4) 0 0;
    }

    /* ── AI section ── */
    .ai-harness { border-bottom:1px solid var(--ui-border); padding-bottom:var(--ui-space-7); margin-bottom:var(--ui-space-7); }
    .ai-harness-head { display:flex; align-items:center; gap:var(--ui-space-4); flex-wrap:wrap; }
    .ai-harness-mark { display:block; width:var(--ui-icon-lg); height:var(--ui-icon-lg); flex:none; background:var(--ui-text); mask:var(--gemini-mark) center/contain no-repeat; }
    .ai-harness-name { margin:0; font-size:var(--ui-text-lg); font-weight:600; flex:1; }
    .ai-harness p { color:var(--ui-text-muted); line-height:1.5; margin:var(--ui-space-4) 0 0; }
    .ai-harness code { color:var(--ui-text); overflow-wrap:anywhere; }
    .ai-harness-actions { display:flex; gap:var(--ui-space-3); flex-wrap:wrap; margin-top:var(--ui-space-5); }
    .ai-login-link { display:inline-block; margin-top:var(--ui-space-4); color:var(--ui-accent); overflow-wrap:anywhere; }
    .ai-login-code { display:block; width:100%; margin-top:var(--ui-space-4); }
    .ai-status {
      margin: 0 0 var(--ui-space-5);
      color: var(--ui-text);
    }

    .ai-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ui-space-4);
      margin-top: var(--ui-space-5);
    }

    .settings-feedback {
      margin-top: var(--ui-space-5);
    }

    .ai-note {
      margin-top: var(--ui-space-6);
      font-size: var(--ui-text-sm);
      line-height: 1.5;
      color: var(--ui-text-muted);
    }

    /* ── Voice section ──────────────────────────────────────────────────
     *
     * Status is carried by a TYPOGRAPHIC MARKER in a fixed gutter plus the
     * wording of the line itself — never by a rounded card with one bold
     * edge, and never by colour alone. Colour lands on the marker glyph and
     * only reinforces what the glyph and the sentence already say, so the
     * meaning survives a monochrome display, a light palette, and a dark one.
     *
     * Everything below is single-column and wraps. This form is configured
     * from a phone.
     */
    .v-line {
      display: flex;
      align-items: baseline;
      gap: var(--ui-space-4);
      margin: 0 0 var(--ui-space-5);
      font-size: var(--ui-text-sm);
      line-height: 1.5;
      color: var(--ui-text);
    }

    /* The fixed gutter. Fixed width so every marker aligns down the column
     * and the text starts at the same x whatever the glyph is. */
    .v-mark {
      flex: none;
      width: 1.1em;
      text-align: center;
      font-weight: 700;
      /* Tabular so the glyphs cannot shift the text beside them. */
      font-variant-numeric: tabular-nums;
    }

    .v-mark.ok   { color: var(--ui-success); }
    .v-mark.bad  { color: var(--ui-danger-text); }
    .v-mark.none { color: var(--ui-text-muted); }

    .v-field {
      margin-top: var(--ui-space-6);
    }

    mux-ui-switch.v-toggle { display:block; margin-bottom:var(--ui-space-7); }
    mux-ui-radio-group.v-modes { margin-bottom:var(--ui-space-2); }

    .v-label {
      display: block;
      margin-bottom: var(--ui-space-2);
      font-size: var(--ui-text-xs);
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--ui-text-muted);
    }

    .v-hint {
      margin: var(--ui-space-2) 0 0;
      font-size: var(--ui-text-sm);
      line-height: 1.5;
      color: var(--ui-text-muted);
    }

    .v-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ui-space-4);
      margin-top: var(--ui-space-6);
    }

    .v-note {
      margin-top: var(--ui-space-7);
      font-size: var(--ui-text-sm);
      line-height: 1.55;
      color: var(--ui-text-muted);
    }

    .v-note code {
      font-size: var(--ui-text-xs);
      word-break: break-all;
    }

    /* A refusal or a check result. Same gutter as .v-line so the marker
     * column is continuous down the pane. */
    .v-message {
      display: flex;
      align-items: baseline;
      gap: var(--ui-space-4);
      margin-top: var(--ui-space-6);
      font-size: var(--ui-text-sm);
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--ui-text);
    }

    /* ── Remotes ── */
    .r-row {
      display: flex;
      align-items: center;
      gap: var(--ui-space-5);
      padding: var(--ui-space-5) var(--ui-space-5);
      border: 1px solid var(--ui-border);
      border-radius: var(--ui-radius-md);
      margin-bottom: var(--ui-space-4);
      background: var(--ui-surface-raised);
    }
    .r-row.connected {
      border-color: color-mix(in srgb, var(--ui-success) 35%, var(--ui-border));
    }
    .r-row.degraded {
      border-color: color-mix(in srgb, var(--ui-warning) 45%, var(--ui-border));
      background: color-mix(in srgb, var(--ui-warning) 6%, var(--ui-surface-raised));
    }
    .r-row.err {
      border-color: color-mix(in srgb, var(--ui-danger-text) 40%, var(--ui-border));
    }

    .r-dot {
      width: var(--ui-status-dot-lg);
      height: var(--ui-status-dot-lg);
      border-radius: 50%;
      flex-shrink: 0;
    }
    .r-dot.ok { background: var(--ui-success); }
    .r-dot.warn { background: var(--ui-warning); }
    .r-dot.err { background: var(--ui-danger-text); }
    .r-dot.off {
      background: transparent;
      border: 1px solid var(--ui-text-muted);
    }

    .r-main {
      flex: 1;
      min-width: 0;
    }

    .r-name {
      font-size: var(--ui-text-md);
      font-weight: 500;
      color: var(--ui-text);
    }

    .r-sub {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: var(--ui-text-xs);
      color: var(--ui-text-muted);
      margin-top: var(--ui-space-1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .r-sub.err {
      color: var(--ui-danger-text);
    }

    .r-state {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: var(--ui-text-xs);
      flex-shrink: 0;
      color: var(--ui-warning);
    }

    .application-version { margin:var(--ui-space-7) 0 var(--ui-space-6); font-size:var(--ui-text-3xl); font-weight:600; color:var(--ui-text); }
    .application-actions { display:flex; flex-wrap:wrap; gap:var(--ui-space-5); margin:var(--ui-space-6) 0; }
    .application-shortcuts { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--ui-space-6); align-items:baseline; }
    .application-shortcuts dd { margin:0; text-align:right; }
    .application-shortcuts kbd { font:inherit; color:var(--ui-text); }
    .r-row mux-ui-button { flex-shrink: 0; }
    .r-actions { display: flex; flex: none; align-items: center; flex-wrap: wrap; gap: var(--ui-space-4); }

    @media (max-width: 767.98px) {
      .header { min-height: var(--ui-row-touch); box-sizing: border-box; padding: var(--ui-space-5) var(--ui-space-6); }
      .body { min-height: 0; flex-direction: column; }
      .sidebar {
        box-sizing: border-box;
        display: flex;
        flex: none;
        width: 100%;
        min-height: var(--ui-settings-section-nav-height);
        padding: 0 var(--ui-space-4);
        overflow-x: auto;
        overflow-y: hidden;
        border-right: 0;
        border-bottom: 1px solid var(--ui-border);
        -webkit-overflow-scrolling: touch;
      }
      .content { min-width: 0; padding: var(--ui-space-7) var(--ui-space-6) var(--ui-space-9); }
      .theme-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: var(--ui-settings-theme-grid-width); }
      .r-row { flex-wrap: wrap; }
      .r-main { flex: 1 1 calc(100% - var(--ui-space-7)); }
      .r-actions { flex: 1 1 100%; justify-content: flex-end; }
    }

  `;

  @property({ attribute: false }) config: ResolvedConfig | null = null;
  @property({ type: String }) serverAddr = '';
  @property({ attribute: false }) aiStatus: AIStatus = DEFAULT_AI_STATUS;
  @property({ attribute: false }) openSection: SettingsSection | null = null;
  @property({ type: Boolean, attribute: 'page-mode', reflect: true }) pageMode = false;

  @state() private _section: SettingsSection = 'appearance';
  private _lastScrolledSection: SettingsSection | null = null;
  @state() private _updateStatus: UpdateStatus | null = null;
  @state() private _checkingVersion = false;
  @state() private _installingUpdate = false;
  @state() private _updateError = '';
  @state() private _notifPermission: NotificationPermission | 'unsupported' = 'default';
  @state() private _notifRequesting = false;
  @state() private _aiKeyInput = '';
  @state() private _aiBusy = false;
  @state() private _aiMessage = '';
  @state() private _aiMessageKind: FeedbackKind = 'info';
  @state() private _geminiStatus: 'checking' | 'missing' | 'sign-in' | 'connected' | 'error' = 'checking';
  @state() private _geminiCopied = '';
  @state() private _geminiLogin: GeminiLoginStatus = { state:'idle' };
  @state() private _geminiCode = '';
  @state() private _geminiLoginBusy = false;
  @state() private _geminiLoginError = '';
  @state() private _geminiAuth: GeminiAuth = { mode:'google', apiKeyDetected:false };
  @state() private _geminiAuthBusy = false;
  @state() private _geminiAuthError = '';
  private _geminiPollTimer?: number;
  private _geminiLoginEpoch = 0;
  private _geminiLoadEpoch = 0;

  // ── Voice credentials ──────────────────────────────────────────────────
  // _voice is what the SERVER says. The _v* fields are the form's own edits,
  // seeded from it on load and after every save. They are kept separate so a
  // save that the server refuses leaves the user's typing on screen to fix,
  // rather than snapping back to the last accepted state.
  //
  // There is no _voiceKeyStored mirror of the key: the key exists in the form
  // input until it is sent, and nowhere else in this component. `keyConfigured`
  // on the server status is a boolean and is all that is ever known about a
  // saved one.
  @state() private _voice: VoiceStatus = DEFAULT_VOICE_STATUS;
  @state() private _voiceLoaded = false;
  @state() private _vMode: VoiceMode = 'azure_entra';
  @state() private _vEnabled = false;
  @state() private _vEndpoint = '';
  @state() private _vModel = '';
  @state() private _vScope = '';
  @state() private _vKeyInput = '';
  @state() private _voiceBusy = false;
  @state() private _voiceMessage = '';
  /** 'ok' | 'bad' | '' — drives the typographic marker, never colour alone. */
  @state() private _voiceMessageKind: 'ok' | 'bad' | '' = '';
  // Per-browser (localStorage), not server config — distinguishes this
  // machine's window/PWA from other muxterm instances. See instance-identity.ts.
  @state() private _titlebarColor: string | null = restoreTitlebarColor();

  @state() private _remotes: RemotesList = EMPTY_REMOTES;
  @state() private _remotesError = '';
  @state() private _addTarget = '';
  @state() private _addError = '';
  /**
   * The verbatim failure of the last action on a host, by id.
   *
   * A failed /connect is already recorded server-side (the host turns
   * unreachable and the next GET carries ssh's words), but a failed
   * /provision is not: the deploy never got far enough to make the host
   * unreachable, so without this the button would sit silent for up to three
   * minutes and then change nothing. Rendered through the same .r-row.err the
   * server's own errors use — no second vocabulary for the same fact.
   */
  private _rowErrors = new Map<string, string>();
  /** Host ids with a request in flight. Their buttons are disabled. */
  private _pending = new Set<string>();
  private _unsubRemotes: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._refreshNotifPermission();
    // host-state is the only thing that moves a row between sections without
    // this pane asking for it, so it is the only thing that refetches.
    this._unsubRemotes = remotesStore.subscribe(() => {
      if (this._section === 'remotes') void this._loadRemotes();
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearTimeout(this._geminiPollTimer);
    ++this._geminiLoginEpoch;
    ++this._geminiLoadEpoch;
    this._unsubRemotes?.();
    this._unsubRemotes = null;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (changed.has('openSection') && this.openSection !== null) {
      const changedSection = this._setSection(this.openSection);
      if (changedSection && this.openSection === 'remotes') void this._loadRemotes();
      if (changedSection && this.openSection === 'voice') void this._loadVoice();
      if (changedSection && this.openSection === 'ai') void this._loadGemini();
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (this._lastScrolledSection === this._section) return;
    void this._scrollActiveSection();
  }

  private async _scrollActiveSection(): Promise<void> {
    const nav = this.renderRoot.querySelector<HTMLElement>('.sidebar');
    if (!nav) return;
    await Promise.all(Array.from(nav.querySelectorAll('mux-ui-nav-item'), item => item.updateComplete));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (this._lastScrolledSection === this._section) return;
    this._lastScrolledSection = this._section;
    if (nav.scrollWidth > nav.clientWidth) {
      nav.querySelector<HTMLElement>('mux-ui-nav-item[active]')
        ?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }

  private _setSection(section: SettingsSection): boolean {
    if (this._section === section) return false;
    this._section = section;
    if (section === 'about') void this._checkVersion();
    return true;
  }

  private _selectSection(section: SettingsSection): void {
    if (!this._setSection(section)) return;
    if (section !== 'ai') {
      window.clearTimeout(this._geminiPollTimer);
      ++this._geminiLoginEpoch;
      ++this._geminiLoadEpoch;
    }
    if (section === 'voice') void this._loadVoice();
    if (section === 'ai') void this._loadGemini();
    if (section === 'remotes') void this._loadRemotes();
  }

  private async _checkVersion(): Promise<void> {
    if (this._checkingVersion || this._installingUpdate) return;
    this._checkingVersion = true;
    this._updateError = '';
    try {
      this._updateStatus = await fetchUpdateStatus();
      window.dispatchEvent(new CustomEvent('muxterm-update-checked', { detail: this._updateStatus }));
    } catch {
      this._updateError = 'Could not check the version. Try again.';
    } finally {
      this._checkingVersion = false;
    }
  }

  private async _installUpdate(): Promise<void> {
    if (this._checkingVersion || this._installingUpdate || !this._updateStatus?.canUpdate) return;
    this._installingUpdate = true;
    this._updateError = '';
    try {
      await installUpdate(this._updateStatus.currentVersion);
    } catch (error) {
      this._updateError = error instanceof Error ? error.message : String(error);
      this._installingUpdate = false;
    }
  }

  private _applicationAction(action: 'reconnect' | 'new-workspace'): void {
    this.dispatchEvent(new CustomEvent('launcher-action', { detail: { action }, bubbles: true, composed: true }));
  }

  private _renderAbout() {
    const status = this._updateStatus;
    const message = this._installingUpdate ? 'Installing update. Muxterm will reconnect when it is ready.'
      : this._checkingVersion ? 'Checking version…'
      : this._updateError || (status?.error ? `Could not check: ${status.error}`
      : status?.devBuild ? 'Development build. Updates are managed by your build.'
      : status?.updateAvailable ? `Version ${status.latestVersion} is available.${status.canUpdate ? '' : ` ${status.reason || 'Update through your package manager.'}`}`
      : status?.latestVersion ? 'You’re up to date.' : 'Check for the latest version.');
    return html`
      <h3>About muxterm</h3>
      <p>muxterm brings your terminals and agent chats into one workspace.</p>
      <div class="application-version">${status?.currentVersion ? `v${status.currentVersion.startsWith('v') ? status.currentVersion.slice(1) : status.currentVersion}` : 'Version unavailable'}</div>
      <div class="application-actions">
        <mux-ui-button variant="secondary" ?busy=${this._checkingVersion} ?disabled=${this._installingUpdate} @click=${() => void this._checkVersion()}>Check version</mux-ui-button>
        <mux-ui-button variant="primary" ?busy=${this._installingUpdate} ?disabled=${!status?.canUpdate || this._checkingVersion} @click=${() => void this._installUpdate()}>Update</mux-ui-button>
      </div>
      <mux-ui-feedback class="settings-feedback" kind=${this._updateError || status?.error ? 'error' : this._checkingVersion || this._installingUpdate ? 'loading' : status?.updateAvailable ? 'info' : 'success'} density="compact">${message}</mux-ui-feedback>
      <p>Build <code>${__GIT_SHA__}</code></p>
      <p>Config file: <code>~/.config/muxterm/config.toml</code></p>`;
  }

  private _renderWorkspaces() {
    return html`
      <h3>Workspaces</h3>
      <p>Create a workspace for your terminals or reconnect to this Muxterm instance.</p>
      <div class="application-actions">
        <mux-ui-button variant="secondary" @click=${() => this._applicationAction('new-workspace')}>New workspace</mux-ui-button>
        <mux-ui-button variant="secondary" @click=${() => this._applicationAction('reconnect')}>Reconnect</mux-ui-button>
      </div>`;
  }

  private _renderShortcuts() {
    const keys = this.config!.keys;
    const shortcuts = [
      ['New pane (any mode)', 'Cmd+Ctrl+T'], ['Close pane', 'Cmd+W / Ctrl+W'],
      ['Cycle tabs (forward)', 'Ctrl+Tab'], ['Cycle tabs (backward)', 'Ctrl+Shift+Tab'],
      ['Next session', keys.nextSession], ['Split pane', keys.split],
      ['Open Settings', keys.openLauncher], ['Focus driver', keys.focusDriver],
    ];
    return html`<h3>Keyboard Shortcuts</h3><dl class="application-shortcuts">${shortcuts.map(([label, key]) => html`<dt>${label}</dt><dd><kbd>${key}</kbd></dd>`)}</dl>`;
  }

  private _refreshNotifPermission(): void {
    if (!('Notification' in window)) {
      this._notifPermission = 'unsupported';
    } else {
      this._notifPermission = Notification.permission;
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private _emit(partial: Partial<ResolvedConfig>): void {
    if (!this.config) return;
    const next: ResolvedConfig = { ...this.config, ...partial };
    this.dispatchEvent(new CustomEvent('config-change', {
      detail: { config: next },
      bubbles: true,
      composed: true,
    }));
  }

  private _setTheme(palette: string): void {
    this._emit({ theme: { palette } });
  }

  private _setFontFamily(family: string): void {
    if (!this.config) return;
    this._emit({ font: { ...this.config.font, family } });
  }

  private _setFontSize(size: number): void {
    if (!this.config) return;
    this._emit({ font: { ...this.config.font, size } });
  }

  private _setBell(bell: ResolvedConfig['terminal']['bell']): void {
    if (!this.config) return;
    this._emit({ terminal: { ...this.config.terminal, bell } });
  }

  /** Applies + persists a new title-bar accent color immediately (no server round trip). */
  private _setTitlebarColor(color: string): void {
    this._titlebarColor = color;
    persistTitlebarColor(color);
    applyTitlebarColor(color);
  }

  /** Clears the custom title-bar color, reverting to the current theme's default. */
  private _resetTitlebarColor(): void {
    this._titlebarColor = null;
    persistTitlebarColor(null);
    applyTitlebarColor(null);
  }

  private _sendTestNotification(): void {
    try {
      new Notification('muxterm', {
        body: 'Notifications are working! You\'ll see this when a terminal bell fires in a background pane.',
        tag: 'muxterm-test',
        silent: false,
      });
    } catch (e) {
      console.error('muxterm: test notification failed:', e);
    }
  }

  private async _requestNotificationPermission(): Promise<void> {
    if (this._notifRequesting) return;
    this._notifRequesting = true;
    try {
      const result = await Notification.requestPermission();
      this._notifPermission = result;
    } catch {
      this._notifPermission = 'unsupported';
    } finally {
      this._notifRequesting = false;
    }
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  private _renderThemeGroup(cards: ThemeCard[], current: string) {
    return cards.map(card => {
      const palette = PALETTES[card.id];
      return palette ? html`<mux-ui-theme-choice label=${card.label} .preview=${palette}
        ?selected=${current === card.id} @click=${() => this._setTheme(card.id)}></mux-ui-theme-choice>` : html``;
    });
  }

  private _renderThemeCards() {
    const current = this.config?.theme.palette ?? 'tokyo-night';
    return html`
      <div class="theme-grid">
        ${this._renderThemeGroup(DARK_THEMES, current)}
      </div>
      <p class="section-title theme-light-heading">Light</p>
      <div class="theme-grid">
        ${this._renderThemeGroup(LIGHT_THEMES, current)}
      </div>
    `;
  }

  private _renderFontPicker() {
    const cfg = this.config;
    if (!cfg) return html``;
    const family = cfg.font.family;
    const size = cfg.font.size;

    return html`
      <mux-ui-radio-group aria-label="Terminal font family" name="font-family" .value=${family}
        .options=${FONT_FAMILIES.map(f => ({value:f.id,label:f.label,fontFamily:f.id}))}
        @change=${(event: CustomEvent<{value:string}>) => this._setFontFamily(event.detail.value)}></mux-ui-radio-group>
      <mux-ui-range-field class="font-size" layout="inline" label="Size" accessible-label="Terminal font size"
        unit=" px" .min=${8} .max=${24} .value=${size}
        @input=${(event:Event) => this._setFontSize((event.target as MuxUIRangeField).value)}></mux-ui-range-field>
      <div
        class="font-preview"
        style="font-family:'${family}',monospace;font-size:${size}px"
      >The quick brown fox jumps $ █</div>
    `;
  }

  private _renderNotifPermission() {
    const perm = this._notifPermission;

    if (perm === 'unsupported') {
      return html`
        <mux-ui-feedback kind="info" appearance="panel" density="compact">
          Desktop notifications are not supported in this browser.
        </mux-ui-feedback>
      `;
    }

    if (perm === 'granted') {
      return html`
        <div class="notif-permission-actions">
          <mux-ui-status-badge tone="success" dot>Enabled</mux-ui-status-badge>
          <mux-ui-button size="small" variant="secondary" @click="${() => this._sendTestNotification()}">
            Send test notification
          </mux-ui-button>
        </div>
        <p class="notif-hint">
          Notifications appear when a background pane needs your attention.
          If the test does not appear, check your browser and system notification settings.
        </p>
      `;
    }

    if (perm === 'denied') {
      return html`
        <mux-ui-feedback kind="warning" appearance="panel" density="compact">
          Notifications are blocked for this site. Allow them in your browser's site settings.
          <mux-ui-button slot="action" size="small" variant="secondary" @click=${() => this._refreshNotifPermission()}>Check again</mux-ui-button>
        </mux-ui-feedback>
      `;
    }

    // default: not yet requested (or dismissed without choosing)
    return html`
      <mux-ui-button
        variant="primary"
        size="small"
        ?disabled="${this._notifRequesting}"
        @click="${() => this._requestNotificationPermission()}"
      >${this._notifRequesting ? 'Waiting for browser…' : 'Enable Desktop Notifications'}</mux-ui-button>
      ${this._notifRequesting ? html`
        <p class="notif-hint">
          Look for a permission prompt in your browser's address bar or toolbar.
        </p>
      ` : ''}
    `;
  }

  private _renderAppearance() {
    const cfg = this.config;
    if (!cfg) return html``;
    return html`
      <p class="section-title">Theme</p>
      ${this._renderThemeCards()}

      <div class="section-gap">
        <p class="section-title">Font</p>
        ${this._renderFontPicker()}
      </div>

      <div class="section-gap">
        <p class="section-title">Title Bar Color</p>
        ${this._renderTitlebarColorPicker()}
      </div>
    `;
  }

  /** Live --chrome-bar value (theme's current default), as a fallback swatch
   *  seed when no custom title-bar color has been picked yet. Native
   *  The native color picker requires an exact 6-digit hex, which is what every
   *  built-in theme's `bar` token already is (see theme.ts CHROME_DARK/LIGHT). */
  private get _currentChromeBarHex(): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--chrome-bar').trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#16161e';
  }

  /** Crayon set is chosen by the CURRENT theme's brightness, not a fixed
   *  default — the header's text color (--chrome-text-bright) stays fixed
   *  regardless of the custom background, so light themes need pastel
   *  crayons (dark text on top) and dark themes need deep crayons (near-
   *  white text on top). See instance-identity.ts for the contrast rationale. */
  private get _crayons(): TitlebarCrayon[] {
    const palette = this.config?.theme.palette ?? 'tokyo-night';
    return isLightTheme(palette) ? LIGHT_TITLEBAR_CRAYONS : DARK_TITLEBAR_CRAYONS;
  }

  private _renderTitlebarColorPicker() {
    return html`
      <mux-ui-color-picker .options=${this._crayons.map(crayon => ({label:crayon.name,color:crayon.hex}))}
        .value=${this._titlebarColor?.toLowerCase() || ''} .fallbackColor=${this._currentChromeBarHex}
        inputLabel="Pick a custom title bar color"
        @color-change=${(event: CustomEvent<{color:string}>) => this._setTitlebarColor(event.detail.color)}
        @color-reset=${() => this._resetTitlebarColor()}></mux-ui-color-picker>
      <p class="titlebar-hint">
        Only affects this browser on <strong>${instanceLabel()}</strong> — handy for
        telling multiple muxterm instances apart at a glance.
      </p>
    `;
  }

  private _renderNotifications() {
    const cfg = this.config;
    if (!cfg) return html``;
    const bell = cfg.terminal.bell;

    return html`
      <div class="notif-block">
        <p class="section-title">Desktop Alerts</p>
        <p class="notif-description">
          Allow muxterm to send desktop notifications when a terminal needs your attention.
        </p>
        ${this._renderNotifPermission()}
      </div>

      <div class="divider"></div>

      <p class="section-title">Bell</p>
      <mux-ui-radio-group aria-label="Bell" name="bell" .value=${bell}
        .options=${[
          {value:'visual',label:'Visual',description:'Flash the pane tab'},
          {value:'audible',label:'Audible',description:'Play the system bell sound'},
          {value:'off',label:'Off',description:'Silence all bell events'},
        ]}
        @change=${(event: CustomEvent<{value:string}>) => this._setBell(event.detail.value as ResolvedConfig['terminal']['bell'])}></mux-ui-radio-group>
    `;
  }

  private _emitAIStatus(status: AIStatus): void {
    this.aiStatus = status;
    this.dispatchEvent(new CustomEvent('ai-status-change', {
      detail: { status },
      bubbles: true,
      composed: true,
    }));
  }

  private async _loadGemini(): Promise<void> {
    const epoch = ++this._geminiLoadEpoch;
    this._geminiStatus = 'checking';
    void this._readGeminiLogin();
    try {
      const [auth, choices] = await Promise.all([
        fetch(apiPath('/api/ai/gemini/auth')),
        fetch(apiPath('/api/sdk-chat-start-options')),
      ]);
      if (epoch !== this._geminiLoadEpoch) return;
      if (auth.ok) {
        const selection = await auth.json() as GeminiAuth;
        if (epoch !== this._geminiLoadEpoch) return;
        this._geminiAuth = selection;
      }
      if (!choices.ok) throw new Error('Could not check installed agents');
      const options = await choices.json() as Array<{ harness: string }>;
      if (epoch !== this._geminiLoadEpoch) return;
      if (!options.some(option => option.harness === 'gemini')) { this._geminiStatus = 'missing'; return; }
      const catalog = await fetch(apiPath('/api/sdk-chat-catalog?harness=gemini'));
      if (epoch !== this._geminiLoadEpoch) return;
      if (catalog.ok) { this._geminiStatus = 'connected'; return; }
      const detail = await catalog.text();
      if (epoch !== this._geminiLoadEpoch) return;
      this._geminiStatus = /auth|sign.?in|credential|login|api key|not configured/i.test(detail) ? 'sign-in' : 'error';
    } catch { if (epoch === this._geminiLoadEpoch) this._geminiStatus = 'error'; }
  }

  private async _setGeminiAuth(mode: GeminiAuth['mode']): Promise<void> {
    if (this._geminiAuthBusy || this._geminiAuth.mode === mode) return;
    this._geminiAuthBusy = true;
    this._geminiAuthError = '';
    try {
      const response = await fetch(apiPath('/api/ai/gemini/auth'), {
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mode}),
      });
      if (!response.ok) throw new Error((await response.text()).trim());
      this._geminiAuth = await response.json() as GeminiAuth;
      await this._loadGemini();
    } catch (error) { this._geminiAuthError = error instanceof Error ? error.message : String(error); }
    finally { this._geminiAuthBusy = false; }
  }

  private async _readGeminiLogin(): Promise<void> {
    window.clearTimeout(this._geminiPollTimer);
    const epoch = ++this._geminiLoginEpoch;
    try {
      const response = await fetch(apiPath('/api/ai/gemini/login'));
      if (!response.ok) return;
      const login = await response.json() as GeminiLoginStatus;
      if (epoch !== this._geminiLoginEpoch) return;
      this._geminiLogin = login;
      if (this._geminiLogin.state === 'verifying' || this._geminiLogin.state === 'complete') {
        const catalog = await fetch(apiPath('/api/sdk-chat-catalog?harness=gemini'));
        if (epoch !== this._geminiLoginEpoch) return;
        if (catalog.ok) {
          this._geminiStatus = 'connected';
          this._geminiLogin = { state:'complete' };
        }
      }
      if (this.isConnected && this._section === 'ai' && ['starting', 'awaiting_code', 'verifying'].includes(this._geminiLogin.state))
        this._geminiPollTimer = window.setTimeout(() => void this._readGeminiLogin(), 2500);
    } catch { /* The terminal sign-in path remains available. */ }
  }

  private async _geminiLoginRequest(method: 'POST' | 'DELETE', code?: string): Promise<void> {
    if (this._geminiLoginBusy) return;
    ++this._geminiLoginEpoch;
    window.clearTimeout(this._geminiPollTimer);
    this._geminiLoginBusy = true;
    this._geminiLoginError = '';
    try {
      const response = await fetch(apiPath(`/api/ai/gemini/login${code === undefined ? '' : '/code'}`), {
        method, ...(code === undefined ? {} : { headers:{'Content-Type':'application/json'}, body:JSON.stringify({code}) }),
      });
      if (!response.ok) throw new Error((await response.text()).trim());
      this._geminiLogin = await response.json() as GeminiLoginStatus;
      if (code !== undefined) this._geminiCode = '';
      void this._readGeminiLogin();
    } catch (error) { this._geminiLoginError = error instanceof Error ? error.message : String(error); }
    finally { this._geminiLoginBusy = false; }
  }

  private async _copyGemini(command: string): Promise<void> {
    try { await navigator.clipboard.writeText(command); this._geminiCopied = command; }
    catch { this._geminiCopied = ''; }
  }

  private _renderGemini() {
    const status = this._geminiStatus;
    const login = this._geminiLogin;
    const auth = this._geminiAuth;
    const signingIn = ['starting', 'awaiting_code', 'verifying'].includes(login.state);
    const command = status === 'missing' ? 'npm install -g @google/gemini-cli' : 'NO_BROWSER=true gemini';
    const label = status === 'connected' ? 'Ready' : status === 'missing' ? 'Not installed'
      : signingIn ? 'Signing in' : status === 'sign-in' ? 'Sign in needed' : status === 'checking' ? 'Checking' : 'Check unavailable';
    const tone = status === 'connected' ? 'success' : status === 'sign-in' || signingIn ? 'warning' : 'neutral';
    return html`<div class="ai-harness">
      <div class="ai-harness-head"><span class="ai-harness-mark" style=${`--gemini-mark:url("${geminiMark}")`} aria-hidden="true"></span><h3 class="ai-harness-name">Gemini CLI</h3><mux-ui-status-badge tone=${tone} dot>${label}</mux-ui-status-badge></div>
      <p>Choose how Gemini CLI connects. Google sign-in uses your account; an API key uses its own Google AI Studio quota.</p>
      <div class="ai-harness-actions" role="group" aria-label="Gemini authentication method">
        <mux-ui-button size="small" variant=${auth.mode === 'google' ? 'primary' : 'secondary'} ?disabled=${this._geminiAuthBusy || signingIn} @click=${() => void this._setGeminiAuth('google')}>${auth.mode === 'google' ? '✓ ' : ''}Google sign-in</mux-ui-button>
        <mux-ui-button size="small" variant=${auth.mode === 'api-key' ? 'primary' : 'secondary'} ?disabled=${this._geminiAuthBusy || signingIn || !auth.apiKeyDetected} @click=${() => void this._setGeminiAuth('api-key')}>${auth.mode === 'api-key' ? '✓ ' : ''}Detected API key</mux-ui-button>
      </div>
      <p>${auth.apiKeyDetected ? 'GEMINI_API_KEY detected; its value stays hidden.' : 'No GEMINI_API_KEY found in the server environment or ~/.amplifier/keys.env.'}</p>
      ${this._geminiAuthError ? html`<mux-ui-feedback kind="error" density="compact">${this._geminiAuthError}</mux-ui-feedback>` : ''}
      ${status === 'connected' ? html`<p>Gemini is ready in New Chat.</p>` : status === 'missing' ? html`<p>Install Gemini CLI on this machine first.</p><p><code>${command}</code></p>` : html`
        ${login.state === 'starting' ? html`<p>Starting Google sign-in in Gemini CLI…</p>` : ''}
        ${login.state === 'awaiting_code' ? html`<p>Open Google's sign-in page, approve access, then paste the authorization code here.</p><a class="ai-login-link" href=${login.url || ''} target="_blank" rel="noopener noreferrer">Open Google sign-in ↗</a><mux-ui-text-field class="ai-login-code" aria-label="Google authorization code" autocomplete="one-time-code" placeholder="Authorization code" .value=${this._geminiCode} @input=${(event: Event) => { this._geminiCode = (event.target as MuxUITextField).value; }}></mux-ui-text-field>` : ''}
        ${login.state === 'verifying' ? html`<p>Checking your Google sign-in…</p>` : ''}
        ${login.state === 'error' ? html`<p>${login.message || 'Gemini CLI sign-in ended. Try again.'}</p>` : ''}
        ${login.state === 'complete' ? html`<p>Gemini CLI finished signing in. Check the connection.</p>` : ''}
        ${login.state === 'idle' && auth.mode === 'google' ? html`<p>Sign in with the Google account linked to your subscription.</p>` : ''}
        ${auth.mode === 'api-key' ? html`<p>Check the detected API key connection.</p>` : ''}
      `}
      ${this._geminiLoginError ? html`<mux-ui-feedback kind="error" density="compact">${this._geminiLoginError}</mux-ui-feedback>` : ''}
      <div class="ai-harness-actions">
        ${auth.mode === 'google' && status !== 'connected' && status !== 'missing' && ['idle', 'error', 'complete'].includes(login.state) ? html`<mux-ui-button size="small" variant="primary" ?disabled=${this._geminiLoginBusy} @click=${() => void this._geminiLoginRequest('POST')}>Sign in with Google</mux-ui-button>` : ''}
        ${status !== 'connected' && login.state === 'awaiting_code' ? html`<mux-ui-button size="small" variant="primary" ?disabled=${this._geminiLoginBusy || !this._geminiCode.trim()} @click=${() => void this._geminiLoginRequest('POST', this._geminiCode.trim())}>Finish sign-in</mux-ui-button>` : ''}
        ${['starting', 'awaiting_code', 'verifying'].includes(login.state) ? html`<mux-ui-button size="small" variant="secondary" ?disabled=${this._geminiLoginBusy} @click=${() => void this._geminiLoginRequest('DELETE')}>Cancel</mux-ui-button>` : ''}
        ${auth.mode === 'google' && status !== 'connected' ? html`<mux-ui-button size="small" variant="secondary" @click=${() => void this._copyGemini(command)}>${this._geminiCopied === command ? 'Copied' : 'Copy terminal command'}</mux-ui-button><mux-ui-button size="small" variant="secondary" @click=${() => this.dispatchEvent(new CustomEvent('terminal-open', { bubbles:true, composed:true }))}>Open terminal</mux-ui-button>` : ''}
        <mux-ui-button size="small" variant="secondary" ?disabled=${status === 'checking'} @click=${() => void this._loadGemini()}>Check connection</mux-ui-button>
      </div>
      ${auth.mode === 'google' && status !== 'connected' && status !== 'missing' ? html`<p>Terminal fallback: <code>${command}</code></p>` : ''}
    </div>`;
  }

  private async _saveAIKey(): Promise<void> {
    const key = this._aiKeyInput.trim();
    if (!key || this._aiBusy) return;
    this._aiBusy = true;
    this._aiMessage = '';
    try {
      this._emitAIStatus(await saveAIKey(key));
      this._aiKeyInput = '';
      this._aiMessage = 'Key saved.';
      this._aiMessageKind = 'success';
    } catch {
      this._aiMessage = 'Could not save the key -- it was not stored.';
      this._aiMessageKind = 'error';
    } finally {
      this._aiBusy = false;
    }
  }

  private async _removeAIKey(): Promise<void> {
    if (this._aiBusy) return;
    this._aiBusy = true;
    this._aiMessage = '';
    try {
      this._emitAIStatus(await clearAIKey());
      this._aiKeyInput = '';
      this._aiMessage = 'Key removed.';
      this._aiMessageKind = 'success';
    } catch {
      this._aiMessage = 'Could not remove the key.';
      this._aiMessageKind = 'error';
    } finally {
      this._aiBusy = false;
    }
  }

  private async _testAI(): Promise<void> {
    if (this._aiBusy) return;
    this._aiBusy = true;
    this._aiMessage = 'Testing...';
    this._aiMessageKind = 'loading';
    try {
      const res = await pingAI();
      this._aiMessageKind = res.ok ? 'success' : 'error';
      this._aiMessage = res.ok
        ? 'Connected to Anthropic.'
        : res.error === 'ai_disabled'
          ? 'AI is off -- save a key first.'
          : res.error === 'provider_unreachable'
            ? 'Could not reach Anthropic. Check your connection.'
            : 'Anthropic rejected the request. Check the key.';
    } catch {
      this._aiMessage = 'Test failed -- check your connection.';
      this._aiMessageKind = 'error';
    } finally {
      this._aiBusy = false;
    }
  }

  private _renderAI() {
    const st = this.aiStatus;
    return html`
      <p class="section-title">Coding harnesses</p>
      ${this._renderGemini()}
      <p class="section-title">Built-in Anthropic AI</p>
      <p class="ai-status">
        ${st.enabled
          ? `Anthropic features enabled -- key ending ${st.keyHint} (from ${st.source}).`
          : 'Anthropic features are off -- add an API key to enable them.'}
      </p>
      <mux-ui-text-field
        label="API key"
        type="password"
        autocomplete="off"
        placeholder="sk-ant-..."
        .value="${this._aiKeyInput}"
        @input="${(e: Event) => { this._aiKeyInput = (e.target as HTMLInputElement).value; }}"
      ></mux-ui-text-field>
      <div class="ai-actions">
        <mux-ui-button size="small" variant="primary"
          ?disabled="${this._aiBusy || this._aiKeyInput.trim() === ''}"
          @click="${this._saveAIKey}"
        >Save</mux-ui-button>
        ${st.source === 'settings'
          ? html`<mux-ui-button size="small" variant="danger" ?disabled="${this._aiBusy}" @click="${this._removeAIKey}">Remove</mux-ui-button>`
          : ''}
        <mux-ui-button size="small" ?disabled="${this._aiBusy}" @click="${this._testAI}">Test connection</mux-ui-button>
      </div>
      ${this._aiMessage ? html`<mux-ui-feedback class="settings-feedback" kind=${this._aiMessageKind} appearance=${this._aiMessageKind === 'error' ? 'panel' : 'plain'} density="compact">${this._aiMessage}</mux-ui-feedback>` : ''}
      <p class="ai-note">
        The key is stored locally at <code>$XDG_CONFIG_HOME/muxterm/anthropic_key</code>
        (defaults to <code>~/.config/muxterm/anthropic_key</code> when
        <code>XDG_CONFIG_HOME</code> is unset) with owner-only permissions, is
        never returned by the server, and is sent only to Anthropic.
      </p>
    `;
  }

  // ── Voice ───────────────────────────────────────────────────────────────────

  /** GET /api/voice/settings, then seed the form from what the server said. */
  private async _loadVoice(): Promise<void> {
    try {
      this._applyVoiceStatus(await fetchVoiceStatus());
    } catch {
      this._voiceMessage = 'Could not read the voice settings from the server.';
      this._voiceMessageKind = 'bad';
    } finally {
      this._voiceLoaded = true;
    }
  }

  /**
   * Adopt a server status as the new truth and reseed the form from it.
   *
   * The key input is cleared unconditionally: whatever was typed has either
   * been saved or refused, and leaving a secret sitting in a DOM input after
   * either outcome is a live credential in a page that may stay open for days.
   */
  private _applyVoiceStatus(st: VoiceStatus): void {
    this._voice = st;
    this._vMode = st.mode;
    this._vEnabled = st.enabled;
    this._vEndpoint = st.endpoint;
    this._vModel = st.model;
    this._vScope = st.entraScope || (st.allowedScopes[0] ?? '');
    this._vKeyInput = '';
  }

  private _setVoiceMode(mode: VoiceMode): void {
    if (this._vMode === mode) return;
    this._vMode = mode;
    // Moving between shapes must not carry a key across. Entra has nowhere to
    // put one, and a key typed for OpenAI is not the key for an Azure resource.
    this._vKeyInput = '';
    this._voiceMessage = '';
    this._voiceMessageKind = '';
    // OpenAI has exactly one endpoint and the server pins it regardless of what
    // is sent; showing it keeps the form honest about what will be saved.
    if (mode === 'openai_key') {
      this._vEndpoint = OPENAI_ENDPOINT;
    } else if (this._vEndpoint === OPENAI_ENDPOINT) {
      this._vEndpoint = '';
    }
  }

  private async _saveVoice(): Promise<void> {
    if (this._voiceBusy) return;
    this._voiceBusy = true;
    this._voiceMessage = '';
    this._voiceMessageKind = '';
    try {
      const key = this._vKeyInput.trim();
      const st = await saveVoiceSettings({
        enabled: this._vEnabled,
        mode: this._vMode,
        endpoint: this._vEndpoint.trim(),
        model: this._vModel.trim(),
        entraScope: this._vScope,
        ...(key === '' ? {} : { apiKey: key }),
      });
      this._applyVoiceStatus(st);
      this._voiceMessage = 'Saved.';
      this._voiceMessageKind = 'ok';
    } catch (e) {
      // The server's own words. They name the missing field, which is the
      // entire reason this is validated here and not at startup.
      this._voiceMessage = e instanceof Error ? e.message : String(e);
      this._voiceMessageKind = 'bad';
      // A refusal means nothing was written, so a retry needs the key typed
      // again — but a secret must not linger in a page that may stay open for
      // days. Clearing costs a re-type and closes that window.
      this._vKeyInput = '';
    } finally {
      this._voiceBusy = false;
    }
  }

  private async _clearVoiceKey(): Promise<void> {
    if (this._voiceBusy) return;
    this._voiceBusy = true;
    this._voiceMessage = '';
    this._voiceMessageKind = '';
    try {
      this._applyVoiceStatus(await clearVoiceKey());
      this._voiceMessage = 'The saved key was removed.';
      this._voiceMessageKind = 'ok';
    } catch (e) {
      this._voiceMessage = e instanceof Error ? e.message : String(e);
      this._voiceMessageKind = 'bad';
    } finally {
      this._voiceBusy = false;
    }
  }

  private async _checkVoice(): Promise<void> {
    if (this._voiceBusy) return;
    this._voiceBusy = true;
    this._voiceMessage = 'Checking…';
    this._voiceMessageKind = '';
    try {
      const res = await checkVoice();
      this._voiceMessage = res.detail;
      this._voiceMessageKind = res.ok ? 'ok' : 'bad';
    } catch {
      this._voiceMessage = 'The check could not run — check your connection.';
      this._voiceMessageKind = 'bad';
    } finally {
      this._voiceBusy = false;
    }
  }

  /** One status line: marker in the gutter, meaning in the words. */
  private _vLine(kind: 'ok' | 'bad' | 'none', text: string) {
    return html`
      <p class="v-line">
        <span class="v-mark ${kind}" aria-hidden="true">${VOICE_GLYPH[kind]}</span>
        <span>${text}</span>
      </p>
    `;
  }

  private _renderVoice() {
    const st = this._voice;
    const isEntra = this._vMode === 'azure_entra';
    const isOpenAI = this._vMode === 'openai_key';

    /**
     * A SAVED KEY BELONGS TO THE MODE IT WAS SAVED FOR.
     *
     * Without this the form lies as soon as someone switches shape: with an
     * Entra config saved, picking "Azure — access key" would label an empty
     * box "Replace key" and offer to keep a key that does not exist. An Azure
     * resource key is also not an OpenAI key, so moving between the two key
     * modes has to forget it too.
     */
    const savedKeyApplies = st.mode === this._vMode && st.keyConfigured;

    // What the CREDENTIAL line says. Entra is the interesting case: it stores
    // no secret at all, so "no key configured" would be a lie about a working
    // setup.
    const credLine = isEntra
      ? this._vLine('ok', 'Entra sign-in uses the identity this machine is signed in as. No key is stored.')
      : savedKeyApplies && st.keySource === 'env'
        ? this._vLine('ok', `A key is configured, from the ${st.keyEnvVar} environment variable.`)
        : savedKeyApplies
          ? this._vLine('ok', 'A key is configured. It cannot be displayed — replace it or remove it.')
          : this._vLine('none', 'No key configured for this mode.');

    return html`
      <p class="section-title">Voice</p>

      ${this._voiceLoaded ? '' : this._vLine('none', 'Loading…')}
      ${st.enabled ? this._vLine('ok', 'Voice is on.') : this._vLine('none', 'Voice is off.')}
      ${credLine}
      ${st.restartRequired
        ? this._vLine('bad', 'Voice starts with muxterm, so restart it for the saved change to take effect.')
        : ''}

      <mux-ui-switch class="v-toggle" layout="row" label="Enable voice" .checked=${this._vEnabled}
        @change=${(event: CustomEvent<{checked:boolean}>) => { this._vEnabled = event.detail.checked; }}></mux-ui-switch>

      <p class="v-label">How voice signs in</p>
      <mux-ui-radio-group class="v-modes" aria-label="How voice signs in" name="voice-mode" .value=${this._vMode}
        .options=${[
          {value:'azure_entra',label:'Azure OpenAI — Entra sign-in',description:'Uses your signed-in identity. No key to store.'},
          {value:'azure_key',label:'Azure OpenAI — access key',description:'A key from your Azure OpenAI resource.'},
          {value:'openai_key',label:'OpenAI — API key',description:'A key from platform.openai.com.'},
        ]}
        @change=${(event: CustomEvent<{value:string}>) => this._setVoiceMode(event.detail.value as VoiceMode)}></mux-ui-radio-group>

      ${isOpenAI
        ? html`
            <div class="v-field">
              <mux-ui-text-field label="Endpoint" type="url" readonly .value="${OPENAI_ENDPOINT}"></mux-ui-text-field>
              <p class="v-hint">OpenAI has one endpoint, so it is fixed.</p>
            </div>
          `
        : html`
            <div class="v-field">
              <mux-ui-text-field
                label="Endpoint"
                type="url"
                autocomplete="off"
                placeholder="https://NAME.openai.azure.com/openai/v1"
                .value="${this._vEndpoint}"
                @input="${(e: Event) => { this._vEndpoint = (e.target as HTMLInputElement).value; }}"
              ></mux-ui-text-field>
            </div>
          `}

      <div class="v-field">
        <mux-ui-text-field
          label="Model"
          type="text"
          autocomplete="off"
          placeholder="gpt-realtime-2.1-mini"
          .value="${this._vModel}"
          @input="${(e: Event) => { this._vModel = (e.target as HTMLInputElement).value; }}"
        ></mux-ui-text-field>
      </div>

      ${isEntra
        ? html`
            <div class="v-field">
              <mux-ui-select label="Entra scope" .value=${this._vScope}
                .options=${(st.allowedScopes.length ? st.allowedScopes : [this._vScope]).map(s => ({value:s,label:s}))}
                @change=${(event: Event) => { this._vScope = (event.target as MuxUISelect).value; }}></mux-ui-select>
              <p class="v-hint">
                The token audience. AI Foundry resources take the first; Cognitive
                Services resources take the second.
              </p>
            </div>
          `
        : html`
            <div class="v-field">
              <mux-ui-text-field
                label="${savedKeyApplies ? 'Replace key' : 'Key'}"
                type="password"
                autocomplete="off"
                placeholder="${savedKeyApplies ? 'Leave blank to keep the saved key' : 'Paste the key'}"
                .value="${this._vKeyInput}"
                @input="${(e: Event) => { this._vKeyInput = (e.target as HTMLInputElement).value; }}"
              ></mux-ui-text-field>
              <p class="v-hint">
                Write-only. Once saved it is never sent back to this page, so it can
                be replaced or removed but not read.
              </p>
            </div>
          `}

      <div class="v-actions">
        <mux-ui-button size="small" variant="primary" ?disabled="${this._voiceBusy}" @click="${this._saveVoice}">Save</mux-ui-button>
        <mux-ui-button size="small" ?disabled="${this._voiceBusy}" @click="${this._checkVoice}">Check sign-in</mux-ui-button>
        ${savedKeyApplies && st.keySource === 'stored'
          ? html`<mux-ui-button size="small" variant="danger" ?disabled="${this._voiceBusy}" @click="${this._clearVoiceKey}">Remove key</mux-ui-button>`
          : ''}
      </div>

      ${this._voiceMessage
        ? html`
            <p class="v-message" role="status">
              <span class="v-mark ${this._voiceMessageKind || 'none'}" aria-hidden="true"
                >${VOICE_GLYPH[this._voiceMessageKind || 'none']}</span
              >
              <span>${this._voiceMessage}</span>
            </p>
          `
        : ''}

      <p class="v-note">
        “Check sign-in” authenticates for real against the saved settings and lists
        the models — it never starts a session, so it costs nothing.
        <br /><br />
        ${isEntra
          ? html`Entra sign-in stores no key.`
          : html`A key ${savedKeyApplies ? 'is' : 'will be'} stored at
            <code>${st.keyPath || '$XDG_CONFIG_HOME/muxterm/voice_api_key'}</code> with
            owner-only permissions, never in the config file.`}
        Saving rewrites only the
        <code>[voice]</code> section of
        <code>${st.configPath || '~/.config/muxterm/config.toml'}</code>; the rest of
        that file, including your comments, is left exactly as it is. Comments inside
        <code>[voice]</code> itself are replaced.
      </p>
    `;
  }

  // ── Remotes ───────────────────────────────────────────────────────────────

  /** GET /api/remotes — on open, on every host-state, after every mutation. */
  private async _loadRemotes(): Promise<void> {
    // Deliberately the bare GET: ?probe=1 spends an ssh round trip per host
    // and belongs to the connect dialog (plan C.1). This pane serves whatever
    // the probe cache learned, and "unknown" simply offers Connect.
    try {
      const res = await fetch(apiPath('/api/remotes'));
      if (!res.ok) {
        this._remotesError = await remoteErrorText(res);
        return;
      }
      this._remotes = parseRemotesList(await res.json());
      this._remotesError = '';
      // A host the server now reports as connected or reconnecting is one
      // whose last failure is over; keeping the message would explain a
      // problem that no longer exists.
      for (const row of this._remotes.connected) this._rowErrors.delete(row.id);
    } catch (e) {
      this._remotesError = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * POST/DELETE one host route, then refetch.
   *
   * `onOk` runs only when the server actually did the thing — the routes are
   * the authority, so a local state change that is not conditioned on a 2xx is
   * a guess.
   */
  private async _act(
    id: string,
    path: string,
    method: 'POST' | 'DELETE',
    onOk?: () => void,
  ): Promise<void> {
    if (this._pending.has(id)) return;
    this._pending.add(id);
    this._rowErrors.delete(id);
    this.requestUpdate();
    try {
      const res = await fetch(apiPath(path), { method });
      if (res.ok) onOk?.();
      else this._rowErrors.set(id, await remoteErrorText(res));
    } catch (e) {
      this._rowErrors.set(id, e instanceof Error ? e.message : String(e));
    } finally {
      this._pending.delete(id);
      await this._loadRemotes();
      this.requestUpdate();
    }
  }

  private _connect(row: RemoteRow): void {
    void this._act(row.id, `/api/remotes/${encodeURIComponent(row.id)}/connect`, 'POST');
  }

  private _provision(row: RemoteRow): void {
    void this._act(row.id, `/api/remotes/${encodeURIComponent(row.id)}/provision`, 'POST');
  }

  /**
   * "Not now": the host leaves the sidebar entirely and comes back here as a
   * discovered row with a Connect button.
   *
   * The `forget` is what makes that true. C.5 drops the host's registry
   * membership, cancels its session and deletes its merged rows — but the
   * browser's own per-host state lives in `remotesStore`, and an entry left
   * behind keeps `remotesStore.any` true, which keeps a hollow-dot collapsed
   * group on screen for a machine the user just dismissed (Gate 8).
   *
   * This is EXPLICIT-disconnect only. A host that merely drops keeps its entry
   * and ghosts (ux D8) — that is what `reconnecting` is for. The difference is
   * not the outcome on the wire, it is who asked.
   */
  private _disconnect(row: RemoteRow): void {
    void this._act(
      row.id,
      `/api/remotes/${encodeURIComponent(row.id)}/disconnect`,
      'POST',
      () => remotesStore.forget(row.id),
    );
  }

  /**
   * "Remove" deletes the host from ~/.ssh/config, so it is a dismissal in the
   * strongest sense available: the user is saying this machine should stop
   * being offered. It forgets for the same reason _disconnect does -- DELETE
   * also emits a trailing host-state{never-connected}, and without the forget
   * the removed host reappears in the sidebar as an empty group labelled with
   * its raw HostRef.ID, because the tail frame carries no name.
   */
  private _remove(row: RemoteRow): void {
    void this._act(row.id, `/api/remotes/${encodeURIComponent(row.id)}`, 'DELETE', () =>
      remotesStore.forget(row.id),
    );
  }

  /**
   * Retry repeats the action the row's probe implies: a host we know has no
   * muxterm needs installing, not another dial that can only fail the same
   * way. Everything else — including every host we have never probed — dials.
   */
  private _retry(row: RemoteRow): void {
    if (row.probe === 'absent') this._provision(row);
    else this._connect(row);
  }

  private async _addHost(): Promise<void> {
    const target = this._addTarget.trim();
    if (target === '' || this._pending.has(ADD_HOST_KEY)) return;
    this._pending.add(ADD_HOST_KEY);
    this._addError = '';
    this.requestUpdate();
    try {
      // No name: the server derives one from the target and validates it, and
      // says so in the 400 when the derived name will not do.
      const res = await fetch(apiPath('/api/remotes'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      if (!res.ok) {
        this._addError = await remoteErrorText(res);
        return;
      }
      this._addTarget = '';
    } catch (e) {
      this._addError = e instanceof Error ? e.message : String(e);
    } finally {
      this._pending.delete(ADD_HOST_KEY);
      // Adding does not connect (plan C.2); the new host appears in its
      // transport's section with a Connect button, which is the next decision.
      await this._loadRemotes();
      this.requestUpdate();
    }
  }

  /** Only entries muxterm wrote between its own markers can be removed. */
  private _renderRemoveBtn(row: RemoteRow) {
    if (!row.managed) return '';
    return html`
      <mux-ui-button
        size="small" variant="danger"
        ?disabled="${this._pending.has(row.id)}"
        @click="${() => this._remove(row)}"
      >Remove</mux-ui-button>
    `;
  }

  private _renderConnectedRow(row: RemoteRow) {
    const dropped = row.state === 'reconnecting';
    const busy = this._pending.has(row.id);
    return html`
      <div class="r-row ${dropped ? 'degraded' : 'connected'}">
        <span class="r-dot ${dropped ? 'warn' : 'ok'}"></span>
        <div class="r-main">
          <div class="r-name">${row.name}</div>
          <div class="r-sub">${row.target}</div>
        </div>
        <div class="r-actions">
          ${dropped ? html`<span class="r-state">reconnecting</span>` : ''}
          ${dropped
            ? html`<mux-ui-button size="small" variant="secondary" ?disabled="${busy}" @click="${() => this._retry(row)}">Retry</mux-ui-button>`
            : html`<mux-ui-button size="small" variant="danger" ?disabled="${busy}" @click="${() => this._disconnect(row)}">Disconnect</mux-ui-button>`}
          ${this._renderRemoveBtn(row)}
        </div>
      </div>
    `;
  }

  private _renderDiscoveredRow(row: RemoteRow) {
    // The row's own error wins over ours: the server saw the failure the whole
    // fleet sees, we only saw the last button this browser pressed.
    const error = row.error ?? this._rowErrors.get(row.id) ?? '';
    const busy = this._pending.has(row.id);

    // This is the only place in the whole UI where a host reads as broken.
    if (error !== '') {
      return html`
        <div class="r-row err">
          <span class="r-dot err"></span>
          <div class="r-main">
            <div class="r-name">${row.name}</div>
            <div class="r-sub err">${error}</div>
          </div>
          <div class="r-actions">
            <mux-ui-button size="small" variant="secondary" ?disabled="${busy}" @click="${() => this._retry(row)}">Retry</mux-ui-button>
            ${this._renderRemoveBtn(row)}
          </div>
        </div>
      `;
    }

    // "absent" is the one probe result that changes the verb: connecting a
    // host with no muxterm on it can only fail.
    const install = row.probe === 'absent';
    return html`
      <div class="r-row">
        <span class="r-dot off"></span>
        <div class="r-main">
          <div class="r-name">${row.name}</div>
          <div class="r-sub">${row.target}</div>
        </div>
        <div class="r-actions">
          ${install
            ? html`<mux-ui-button size="small" variant="secondary" ?disabled="${busy}" @click="${() => this._provision(row)}">Install &amp; connect</mux-ui-button>`
            : html`<mux-ui-button size="small" variant="primary" ?disabled="${busy}" @click="${() => this._connect(row)}">Connect</mux-ui-button>`}
          ${this._renderRemoveBtn(row)}
        </div>
      </div>
    `;
  }

  private _renderRemotes() {
    const connected = this._remotes.connected;
    // The error rows sit among the ssh-config rows rather than in a section of
    // their own, because that is where the host lives.
    const rest = [...this._remotes.discovered, ...this._remotes.errors].sort(byNameThenID);
    const transports = [...new Set(rest.map(r => r.transport))].sort();

    // A heading with nothing under it explains nothing. The first heading that
    // does render carries no top gap.
    let first = connected.length === 0;

    return html`
      ${this._remotesError ? html`<mux-ui-feedback class="settings-feedback" kind="error" appearance="panel" density="compact">${this._remotesError}<mux-ui-button slot="action" size="small" variant="secondary" @click=${() => void this._loadRemotes()}>Retry</mux-ui-button></mux-ui-feedback>` : ''}
      ${connected.length > 0
        ? html`
            <div class="section-title">Connected</div>
            ${connected.map(row => this._renderConnectedRow(row))}
          `
        : ''}
      ${transports.map(transport => {
        const gap = first ? '' : ' section-gap';
        first = false;
        return html`
          <div class="section-title${gap}">${TRANSPORT_TITLES[transport] ?? transport}</div>
          ${rest
            .filter(row => row.transport === transport)
            .map(row => this._renderDiscoveredRow(row))}
        `;
      })}
      <div class="divider"></div>
      <div class="section-title">Add a host</div>
      <mux-ui-text-field
        type="text"
        aria-label="Host address"
        autocomplete="off"
        placeholder="user@host"
        .value="${this._addTarget}"
        @input="${(e: Event) => { this._addTarget = (e.target as HTMLInputElement).value; this.requestUpdate(); }}"
        @keydown="${(e: KeyboardEvent) => { if (e.key === 'Enter') void this._addHost(); }}"
      ></mux-ui-text-field>
      <div class="ai-actions"><mux-ui-button variant="primary" ?disabled=${!this._addTarget.trim() || this._pending.has(ADD_HOST_KEY)} @click=${() => void this._addHost()}>Add host</mux-ui-button></div>
      ${this._addError ? html`<mux-ui-feedback class="settings-feedback" kind="error" appearance="panel" density="compact">${this._addError}</mux-ui-feedback>` : ''}
    `;
  }

  override render() {
    if (!this.config) return html``;

    return html`
      <div class="header">
        ${this.pageMode ? html`<mux-ui-button variant="quiet" size="large" icon-only accessible-label="Back" tooltip="Back" @click=${this._close}>${icon(ArrowLeft, { size: 20 })}</mux-ui-button>` : ''}
        <h2>Settings</h2>
        ${this.pageMode ? '' : html`<mux-ui-button variant="quiet" icon-only accessible-label="Close settings" tooltip="Close" @click="${this._close}">×</mux-ui-button>`}
      </div>
      <div class="body">
        <nav class="sidebar" aria-label="Settings sections">
          ${SETTINGS_SECTIONS.map(section => html`<mux-ui-nav-item variant="section" label=${section.label} ?active=${this._section === section.id} @click=${() => this._selectSection(section.id)}></mux-ui-nav-item>`)}
        </nav>
        <div class="content">
          ${this._section === 'appearance'
            ? this._renderAppearance()
            : this._section === 'about'
              ? this._renderAbout()
            : this._section === 'workspaces'
              ? this._renderWorkspaces()
            : this._section === 'shortcuts'
              ? this._renderShortcuts()
            : this._section === 'notifications'
              ? this._renderNotifications()
              : this._section === 'remotes'
                ? this._renderRemotes()
                : this._section === 'voice'
                  ? this._renderVoice()
                  : this._renderAI()}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-settings-surface': MuxSettingsSurface;
  }
}
