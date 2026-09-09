import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { PALETTES, isLightTheme } from '../lib/theme.js';
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
import {
  EMPTY_CREDENTIALS_REPORT,
  fetchCredentials,
  saveCredential,
  clearCredential,
  checkCredential,
  credentialMarker,
  credentialSentence,
  type CredentialsReport,
  type ProviderState,
} from '../lib/credentials.js';
import { apiPath } from '../lib/base-path.js';
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

/** The sections the settings surface can open on. */
export type SettingsSection =
  | 'appearance'
  | 'notifications'
  | 'agents'
  | 'ai'
  | 'voice'
  | 'remotes';

/**
 * The sentence for one check outcome.
 *
 * `rejected` and `unreachable` never share wording: the first means the key
 * is wrong, the second means muxterm never got an answer and knows nothing
 * about the key. Collapsing them is what sends someone to replace a key that
 * was fine.
 */
function verdictMessage(p: ProviderState, state: string, httpStatus?: number): string {
  switch (state) {
    case 'ok':
      return `${p.label} accepted the credential.`;
    case 'rejected':
      return `${p.label} REJECTED the credential${httpStatus ? ` (HTTP ${httpStatus})` : ''}. Lanes using ${p.label} will fail. Replace the key below.`;
    case 'unreachable':
      return `Could not reach ${p.label} at ${p.baseURL}. This says nothing about the key — check the network or the endpoint.`;
    case 'absent':
      return `There is no ${p.label} credential on this machine to check.`;
    default:
      return `${p.baseURL} answered unexpectedly${httpStatus ? ` (HTTP ${httpStatus})` : ''}. That usually means the endpoint, not the key.`;
  }
}

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
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: var(--chrome-body);
      color: var(--chrome-text-bright);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      box-sizing: border-box;
      overflow: hidden;
    }

    /* ── Header bar ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px 14px;
      border-bottom: 1px solid var(--chrome-border);
      flex-shrink: 0;
    }

    .header h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: var(--chrome-text-bright);
    }

    .close-btn {
      background: transparent;
      border: none;
      color: var(--chrome-text-dim);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 3px 7px;
      border-radius: 4px;
      transition: color 0.1s, background 0.1s;
    }
    .close-btn:hover {
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
    }

    /* ── Body: sidebar + content ── */
    .body {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* ── Sidebar ── */
    .sidebar {
      width: 156px;
      flex-shrink: 0;
      border-right: 1px solid var(--chrome-border);
      padding: 12px 0;
      overflow-y: auto;
    }

    .sidebar-item {
      display: block;
      width: 100%;
      padding: 9px 18px;
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
      color: var(--chrome-text-dim);
      text-align: left;
      border-radius: 0;
      transition: color 0.1s, background 0.1s;
    }
    .sidebar-item:hover {
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
    }
    .sidebar-item.active {
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
      font-weight: 500;
    }

    /* ── Content area ── */
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 24px 28px 40px;
    }

    /* ── Section headings ── */
    .section-title {
      margin: 0 0 16px 0;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--chrome-text-dim);
    }

    .section-gap {
      margin-top: 32px;
    }

    /* ── Theme card grid ── */
    .theme-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 4px;
    }

    .theme-card {
      position: relative;
      cursor: pointer;
      border-radius: 8px;
      border: 2px solid transparent;
      overflow: hidden;
      transition: border-color 0.15s, transform 0.1s;
      user-select: none;
    }
    .theme-card:hover {
      transform: translateY(-1px);
    }
    .theme-card.active {
      border-color: var(--chrome-accent);
    }

    .card-inner {
      padding: 8px 9px 6px;
      font-size: 9px;
      font-family: 'JetBrainsMonoNerdFont', 'SF Mono', monospace;
      line-height: 1.6;
    }

    .card-topbar {
      display: flex;
      gap: 4px;
      margin-bottom: 6px;
    }
    .card-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .dot-r { background: #ff5f57; }
    .dot-y { background: #febc2e; }
    .dot-g { background: #28c840; }

    .card-prompt { margin-bottom: 1px; }
    .card-files  { margin-top: 1px; }

    .card-cursor {
      display: inline-block;
      width: 6px;
      height: 10px;
      vertical-align: text-bottom;
      margin-top: 1px;
    }

    .card-label {
      font-size: 10px;
      text-align: center;
      padding: 5px 6px 6px;
      color: var(--chrome-text-dim);
      background: var(--chrome-bar);
    }
    .theme-card.active .card-label {
      color: var(--chrome-text-bright);
    }

    .card-check {
      position: absolute;
      top: 5px;
      right: 7px;
      font-size: 10px;
      color: var(--chrome-accent);
      font-weight: 700;
    }

    /* ── Font family radios ── */
    .font-radios {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .font-radio-label {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .font-radio-label:hover {
      background: var(--chrome-hover);
    }

    .font-radio-label input[type="radio"] {
      accent-color: var(--chrome-accent);
      width: 14px;
      height: 14px;
      cursor: pointer;
      flex-shrink: 0;
    }

    .font-radio-name {
      flex: 1;
      color: var(--chrome-text-bright);
    }

    /* ── Font size slider ── */
    .size-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 10px;
      margin-top: 4px;
    }

    .size-label {
      color: var(--chrome-text-dim);
      width: 64px;
      flex-shrink: 0;
    }

    input[type="range"] {
      flex: 1;
      accent-color: var(--chrome-accent);
      height: 4px;
      cursor: pointer;
    }

    .size-value {
      width: 28px;
      text-align: right;
      color: var(--chrome-text-bright);
      font-feature-settings: 'tnum';
    }

    /* ── Font preview line ── */
    .font-preview {
      margin: 10px 0 0 10px;
      padding: 8px 12px;
      background: var(--chrome-bar);
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
      font-size: 12px;
      color: var(--chrome-text-bright);
      overflow: hidden;
      white-space: nowrap;
    }

    /* ── Notifications section ── */
    .notif-block {
      max-width: 480px;
    }

    .notif-description {
      color: var(--chrome-text-dim);
      line-height: 1.55;
      margin: 0 0 14px 0;
    }

    .notif-btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 14px;
      border-radius: 6px;
      border: 1px solid var(--chrome-accent);
      background: transparent;
      color: var(--chrome-accent);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .notif-btn:hover {
      background: var(--chrome-accent);
      color: var(--chrome-body);
    }

    .notif-status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--chrome-text-dim);
      font-size: 13px;
    }
    .notif-status.granted {
      color: #9ece6a; /* tokyo-night green */
    }
    .notif-status.denied {
      color: var(--chrome-danger);
    }

    .notif-help-link {
      display: inline-block;
      margin-top: 6px;
      font-size: 11px;
      color: var(--chrome-accent);
      text-decoration: none;
    }
    .notif-help-link:hover {
      text-decoration: underline;
    }

    .notif-hint {
      margin-top: 8px;
      font-size: 11px;
      color: var(--chrome-text-dim);
      line-height: 1.5;
    }

    .notif-test-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 11px;
      border-radius: 6px;
      border: 1px solid var(--chrome-border);
      background: transparent;
      color: var(--chrome-text-dim);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: border-color 0.12s, color 0.12s;
    }
    .notif-test-btn:hover {
      border-color: var(--chrome-accent);
      color: var(--chrome-text-bright);
    }

    /* ── Theme section label ── */
    .theme-section-label {
      grid-column: 1 / -1;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--chrome-text-dim);
      padding-top: 8px;
    }

    .divider {
      height: 1px;
      background: var(--chrome-border);
      margin: 22px 0;
    }

    /* ── Title bar color picker ── */

    /* Crayon grid — curated presets, same idea as macOS's classic Crayons
       color-picker tab. */
    .crayon-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 12px;
    }

    .crayon {
      position: relative;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: 1px solid rgba(0, 0, 0, 0.12);
      padding: 0;
      cursor: pointer;
      flex-shrink: 0;
      transition: transform 0.08s;
    }
    .crayon:hover {
      transform: scale(1.12);
    }
    .crayon.active {
      box-shadow: 0 0 0 2px var(--chrome-body), 0 0 0 4px var(--chrome-accent);
    }
    .crayon-check {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
    }

    .titlebar-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .titlebar-swatch {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: 1px solid var(--chrome-border);
      padding: 0;
      cursor: pointer;
      flex-shrink: 0;
      /* Native color input chrome varies a lot by browser — strip it down
         to just the swatch so it matches the crayon grid above it. */
      -webkit-appearance: none;
      appearance: none;
      background: none;
    }
    .titlebar-swatch::-webkit-color-swatch-wrapper {
      padding: 0;
    }
    .titlebar-swatch::-webkit-color-swatch {
      border: none;
      border-radius: 50%;
    }

    .titlebar-custom-label {
      font-size: 12px;
      color: var(--chrome-text-dim);
    }

    .titlebar-reset-btn {
      background: transparent;
      border: 1px solid var(--chrome-border);
      color: var(--chrome-text-dim);
      border-radius: 6px;
      padding: 7px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: border-color 0.1s, color 0.1s;
      margin-left: auto;
    }
    .titlebar-reset-btn:hover {
      border-color: var(--chrome-accent);
      color: var(--chrome-text-bright);
    }

    .titlebar-hint {
      font-size: 12px;
      color: var(--chrome-text-dim);
      margin: 0;
    }

    /* ── Bell radios ── */
    .bell-radios {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .bell-radio-label {
      display: flex;
      align-items: flex-start;
      gap: 9px;
      padding: 7px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .bell-radio-label:hover {
      background: var(--chrome-hover);
    }

    .bell-radio-label input[type="radio"] {
      accent-color: var(--chrome-accent);
      width: 14px;
      height: 14px;
      margin-top: 1px;
      cursor: pointer;
      flex-shrink: 0;
    }

    .bell-radio-text {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .bell-radio-name {
      color: var(--chrome-text-bright);
    }

    .bell-radio-desc {
      font-size: 11px;
      color: var(--chrome-text-dim);
    }

    /* ── AI section ── */
    .ai-status {
      margin: 0 0 12px;
      color: var(--chrome-text-bright);
    }

    .ai-input {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 13px;
      color: var(--chrome-text-bright);
      background: var(--chrome-body);
      border: 1px solid var(--chrome-border, #444);
      border-radius: 4px;
    }

    .ai-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }

    .ai-actions button {
      padding: 5px 12px;
      font-family: inherit;
      font-size: 12px;
      color: var(--chrome-text-bright);
      background: var(--chrome-body);
      border: 1px solid var(--chrome-border, #444);
      border-radius: 4px;
      cursor: pointer;
    }

    .ai-actions button[disabled] {
      opacity: 0.5;
      cursor: default;
    }

    .ai-message {
      margin-top: 10px;
      font-size: 12px;
      color: var(--chrome-text-dim);
    }

    .ai-note {
      margin-top: 16px;
      font-size: 11px;
      line-height: 1.5;
      color: var(--chrome-text-dim);
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
      gap: 8px;
      margin: 0 0 10px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--chrome-text-bright);
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

    .v-mark.ok   { color: var(--mux-success, #3d9970); }
    .v-mark.bad  { color: var(--mux-error); }
    .v-mark.none { color: var(--chrome-text-dim); }

    .v-field {
      margin-top: 14px;
    }

    .v-label {
      display: block;
      margin-bottom: 4px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--chrome-text-dim);
    }

    .v-hint {
      margin: 4px 0 0;
      font-size: 11px;
      line-height: 1.5;
      color: var(--chrome-text-dim);
    }

    /* Mode chooser: stacked rows, each a whole tap target. No cards. */
    .v-modes {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-bottom: 4px;
    }

    .v-mode {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 7px 4px;
      font-size: 13px;
      color: var(--chrome-text-bright);
      background: none;
      border: none;
      border-radius: 0;
      text-align: left;
      cursor: pointer;
      font-family: inherit;
    }

    /* Selection is a marker and weight, not a slab. */
    .v-mode[aria-checked='true'] {
      font-weight: 700;
    }

    .v-mode:focus-visible {
      outline: 2px solid var(--chrome-text-bright);
      outline-offset: -2px;
    }

    .v-mode-sub {
      display: block;
      margin-top: 2px;
      font-size: 11px;
      font-weight: 400;
      color: var(--chrome-text-dim);
    }

    .v-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
    }

    .v-actions button {
      padding: 6px 12px;
      font-family: inherit;
      font-size: 12px;
      color: var(--chrome-text-bright);
      background: var(--chrome-body);
      border: 1px solid var(--chrome-border, #444);
      border-radius: 4px;
      cursor: pointer;
    }

    .v-actions button[disabled] {
      opacity: 0.5;
      cursor: default;
    }

    /* The enable toggle reads as a sentence, not a switch in a box. */
    .v-toggle {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin: 0 0 18px;
      font-size: 13px;
      color: var(--chrome-text-bright);
      cursor: pointer;
    }

    .v-toggle input {
      margin: 0;
      flex: none;
    }

    .v-note {
      margin-top: 18px;
      font-size: 11px;
      line-height: 1.55;
      color: var(--chrome-text-dim);
    }

    .v-note code {
      font-size: 10.5px;
      word-break: break-all;
    }

    /* A refusal or a check result. Same gutter as .v-line so the marker
     * column is continuous down the pane. */
    .v-message {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-top: 14px;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--chrome-text-bright);
    }

    /* ── Agent credentials ──────────────────────────────────────────────────
       Same idiom the voice section above uses, and deliberately so: a
       typographic marker in a FIXED GUTTER plus the wording of the line
       beside it. No card, no panel, no bolded edge. Colour lands on the
       glyph alone and only reinforces what the glyph and the sentence
       already say, so the meaning survives a monochrome display and both
       palettes. Single column, wraps, legible at phone width.

       It uses a grid rather than the voice section's flex because these rows
       have a second line under the sentence that must align to the same text
       column, not to the gutter. */
    .cred {
      display: grid;
      grid-template-columns: 1.4em 1fr;
      column-gap: 6px;
      margin: 0 0 4px;
      align-items: start;
    }

    .cred-mark {
      font-weight: 700;
      /* Tabular so the glyphs cannot shift the text beside them. */
      font-variant-numeric: tabular-nums;
      line-height: 1.5;
      text-align: center;
      color: var(--chrome-text-dim);
    }
    .cred-mark.ok { color: var(--mux-success, #3d9970); }
    .cred-mark.warn { color: var(--mux-warn, #d79a2b); }
    .cred-mark.err { color: var(--mux-error); }

    .cred-line {
      line-height: 1.5;
      color: var(--chrome-text-bright);
    }

    .cred-sub {
      grid-column: 2;
      margin: 2px 0 0;
      font-size: 11px;
      line-height: 1.6;
      overflow-wrap: anywhere;
      color: var(--chrome-text-dim);
    }

    /* A hairline between providers. A separator, never a status signal --
       it does not change with state. */
    .cred-block + .cred-block {
      margin-top: 26px;
      padding-top: 22px;
      border-top: 1px solid var(--chrome-border, #333);
    }

    .cred-name {
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--chrome-text-bright);
    }

    /* ── Remotes ── */
    .r-row {
      display: flex;
      align-items: center;
      gap: 11px;
      padding: 10px 12px;
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
      margin-bottom: 8px;
      background: var(--chrome-bar);
    }
    .r-row.connected {
      border-color: color-mix(in srgb, var(--mux-ok) 35%, var(--chrome-border));
    }
    .r-row.degraded {
      border-color: color-mix(in srgb, var(--mux-warn) 45%, var(--chrome-border));
      background: color-mix(in srgb, var(--mux-warn) 6%, var(--chrome-bar));
    }
    .r-row.err {
      border-color: color-mix(in srgb, var(--mux-error) 40%, var(--chrome-border));
    }

    .r-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .r-dot.ok { background: var(--mux-ok); }
    .r-dot.warn { background: var(--mux-warn); }
    .r-dot.err { background: var(--mux-error); }
    .r-dot.off {
      background: transparent;
      border: 1px solid var(--chrome-text-dim);
    }

    .r-main {
      flex: 1;
      min-width: 0;
    }

    .r-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--chrome-text-bright);
    }

    .r-sub {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10.5px;
      color: var(--chrome-text-dim);
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .r-sub.err {
      color: var(--mux-error);
    }

    .r-state {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10px;
      flex-shrink: 0;
      color: var(--mux-warn);
    }

    .r-btn {
      padding: 5px 11px;
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
      background: transparent;
      color: var(--chrome-text-dim);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .r-btn:hover {
      border-color: var(--chrome-accent);
      color: var(--chrome-text-bright);
    }
    .r-btn.pri {
      border-color: var(--chrome-accent);
      color: var(--chrome-accent);
    }
    .r-btn.pri:hover {
      background: var(--chrome-accent);
      color: var(--chrome-body);
    }
    .r-btn.danger:hover {
      border-color: var(--chrome-danger);
      color: var(--chrome-danger);
    }
    .r-btn[disabled] {
      opacity: 0.5;
      cursor: default;
    }

    /* The server's verbatim message for a request that failed outside a row:
       a list that could not be read, or an address it refused to add. */
    .r-error {
      margin-top: 10px;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      color: var(--mux-error);
    }
  `;

  @property({ attribute: false }) config: ResolvedConfig | null = null;
  @property({ type: String }) serverAddr = '';
  @property({ attribute: false }) aiStatus: AIStatus = DEFAULT_AI_STATUS;

  /**
   * Which section to open on. Set by the host so the app-level "lanes cannot
   * run" notice can land the user on the thing that fixes it, rather than on
   * Appearance with a hunt ahead of them.
   */
  @property({ type: String }) section: SettingsSection | '' = '';

  @state() private _section: SettingsSection = 'appearance';

  // ── Agent credentials ──
  @state() private _creds: CredentialsReport = EMPTY_CREDENTIALS_REPORT;
  /** Typed key per provider. Cleared the instant a save returns. */
  @state() private _credInput: Record<string, string> = {};
  /** The provider with a request in flight, or ''. */
  @state() private _credBusy = '';
  /** The last outcome message per provider. */
  @state() private _credMsg: Record<string, string> = {};
  @state() private _notifPermission: NotificationPermission | 'unsupported' = 'default';
  @state() private _notifRequesting = false;
  @state() private _aiKeyInput = '';
  @state() private _aiBusy = false;
  @state() private _aiMessage = '';

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
    if (this.section) this._section = this.section;
    this._refreshNotifPermission();
    // Presence and last-known validity, read from disk and memory server-side
    // -- no provider round trip, so opening Settings costs nothing.
    void this._loadCredentials();
    // host-state is the only thing that moves a row between sections without
    // this pane asking for it, so it is the only thing that refetches.
    this._unsubRemotes = remotesStore.subscribe(() => {
      if (this._section === 'remotes') void this._loadRemotes();
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubRemotes?.();
    this._unsubRemotes = null;
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
          if (!palette) return html``;
          const isActive = current === card.id;
          return html`
            <div
              class="theme-card ${isActive ? 'active' : ''}"
              title="${card.label}"
              @click="${() => this._setTheme(card.id)}"
            >
              <div class="card-inner" style="background:${palette.background}">
                <div class="card-topbar">
                  <span class="card-dot dot-r"></span>
                  <span class="card-dot dot-y"></span>
                  <span class="card-dot dot-g"></span>
                </div>
                <div class="card-prompt">
                  <span style="color:${palette.blue}">~/proj</span>
                  <span style="color:${palette.green}"> main</span>
                </div>
                <div class="card-files">
                  <span style="color:${palette.blue}">src/ </span><span style="color:${palette.green}">run.sh</span>
                </div>
                <div class="card-prompt" style="color:${palette.foreground}">$ ls</div>
                <span class="card-cursor" style="background:${palette.cursor}"></span>
              </div>
              <div class="card-label">${card.label}</div>
              ${isActive ? html`<div class="card-check">✓</div>` : ''}
            </div>
          `;
        });
  }

  private _renderThemeCards() {
    const current = this.config?.theme.palette ?? 'tokyo-night';
    return html`
      <div class="theme-grid">
        ${this._renderThemeGroup(DARK_THEMES, current)}
      </div>
      <p class="section-title" style="margin-top:16px">Light</p>
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
      <div class="font-radios">
        ${FONT_FAMILIES.map(f => html`
          <label class="font-radio-label">
            <input
              type="radio"
              name="font-family"
              .checked="${family === f.id}"
              @change="${() => this._setFontFamily(f.id)}"
            />
            <span class="font-radio-name" style="font-family:'${f.id}',monospace">${f.label}</span>
          </label>
        `)}
      </div>
      <div class="size-row">
        <span class="size-label">Size</span>
        <input
          type="range"
          min="8" max="24" step="1"
          .value="${String(size)}"
          @input="${(e: Event) => {
            const v = parseInt((e.target as HTMLInputElement).value, 10);
            this._setFontSize(v);
          }}"
        />
        <span class="size-value">${size}</span>
      </div>
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
        <p class="notif-description">
          Desktop notifications are not supported in this browser.
        </p>
      `;
    }

    if (perm === 'granted') {
      return html`
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="notif-status granted">✓ Desktop Notifications: Enabled</span>
          <button class="notif-test-btn" @click="${() => this._sendTestNotification()}">
            Send test notification
          </button>
        </div>
        <p class="notif-hint" style="margin-top:8px">
          Notifications appear when a bell fires in a background pane.
          If the test notification doesn't appear, check
          <strong>System Settings → Notifications → [your browser]</strong>
          and make sure "Allow Notifications" is on. macOS Focus / Do Not Disturb
          also suppresses them.
        </p>
      `;
    }

    if (perm === 'denied') {
      return html`
        <span class="notif-status denied">
          Blocked by browser — update in browser settings
        </span>
        <br>
        <a
          class="notif-help-link"
          href="https://support.google.com/chrome/answer/3220216"
          target="_blank"
          rel="noopener noreferrer"
        >How to re-enable notifications →</a>
      `;
    }

    // default: not yet requested (or dismissed without choosing)
    return html`
      <button
        class="notif-btn"
        ?disabled="${this._notifRequesting}"
        @click="${() => this._requestNotificationPermission()}"
      >${this._notifRequesting ? 'Waiting for browser…' : 'Enable Desktop Notifications'}</button>
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
   *  <input type="color"> requires an exact 6-digit hex, which is what every
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
    const color = this._titlebarColor?.toLowerCase() ?? null;
    return html`
      <div class="crayon-grid">
        ${this._crayons.map(crayon => html`
          <button
            class="crayon ${color === crayon.hex ? 'active' : ''}"
            style="background:${crayon.hex}"
            title="${crayon.name}"
            @click="${() => this._setTitlebarColor(crayon.hex)}"
          >${color === crayon.hex ? html`<span class="crayon-check">✓</span>` : ''}</button>
        `)}
      </div>
      <div class="titlebar-row">
        <input
          class="titlebar-swatch"
          type="color"
          title="Pick a custom title bar color"
          .value="${color ?? this._currentChromeBarHex}"
          @input="${(e: Event) => this._setTitlebarColor((e.target as HTMLInputElement).value)}"
        />
        <span class="titlebar-custom-label">Custom…</span>
        <button class="titlebar-reset-btn" @click="${() => this._resetTitlebarColor()}">
          Use theme default
        </button>
      </div>
      <p class="titlebar-hint" style="margin-top:8px">
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
      <div class="bell-radios">
        <label class="bell-radio-label">
          <input
            type="radio"
            name="bell"
            .checked="${bell === 'visual'}"
            @change="${() => this._setBell('visual')}"
          />
          <div class="bell-radio-text">
            <span class="bell-radio-name">Visual</span>
            <span class="bell-radio-desc">Flash the pane tab</span>
          </div>
        </label>
        <label class="bell-radio-label">
          <input
            type="radio"
            name="bell"
            .checked="${bell === 'audible'}"
            @change="${() => this._setBell('audible')}"
          />
          <div class="bell-radio-text">
            <span class="bell-radio-name">Audible</span>
            <span class="bell-radio-desc">Play the system bell sound</span>
          </div>
        </label>
        <label class="bell-radio-label">
          <input
            type="radio"
            name="bell"
            .checked="${bell === 'off'}"
            @change="${() => this._setBell('off')}"
          />
          <div class="bell-radio-text">
            <span class="bell-radio-name">Off</span>
            <span class="bell-radio-desc">Silence all bell events</span>
          </div>
        </label>
      </div>
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

  private async _saveAIKey(): Promise<void> {
    const key = this._aiKeyInput.trim();
    if (!key || this._aiBusy) return;
    this._aiBusy = true;
    this._aiMessage = '';
    try {
      this._emitAIStatus(await saveAIKey(key));
      this._aiKeyInput = '';
      this._aiMessage = 'Key saved.';
    } catch {
      this._aiMessage = 'Could not save the key -- it was not stored.';
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
    } catch {
      this._aiMessage = 'Could not remove the key.';
    } finally {
      this._aiBusy = false;
    }
  }

  private async _testAI(): Promise<void> {
    if (this._aiBusy) return;
    this._aiBusy = true;
    this._aiMessage = 'Testing...';
    try {
      const res = await pingAI();
      this._aiMessage = res.ok
        ? 'Connected to Anthropic.'
        : res.error === 'ai_disabled'
          ? 'AI is off -- save a key first.'
          : res.error === 'provider_unreachable'
            ? 'Could not reach Anthropic. Check your connection.'
            : 'Anthropic rejected the request. Check the key.';
    } catch {
      this._aiMessage = 'Test failed -- check your connection.';
    } finally {
      this._aiBusy = false;
    }
  }

  private _renderAI() {
    const st = this.aiStatus;
    return html`
      <p class="section-title">Anthropic API Key</p>
      <p class="ai-status">
        ${st.enabled
          ? `AI enabled -- key ${st.source === 'settings' ? 'stored in muxterm' : 'from the environment'}.`
          : 'AI features are off -- add an Anthropic API key to enable.'}
      </p>
      <input
        class="ai-input"
        type="password"
        autocomplete="off"
        placeholder="sk-ant-..."
        .value="${this._aiKeyInput}"
        @input="${(e: Event) => { this._aiKeyInput = (e.target as HTMLInputElement).value; }}"
      />
      <div class="ai-actions">
        <button
          ?disabled="${this._aiBusy || this._aiKeyInput.trim() === ''}"
          @click="${this._saveAIKey}"
        >Save</button>
        ${st.source === 'settings'
          ? html`<button ?disabled="${this._aiBusy}" @click="${this._removeAIKey}">Remove</button>`
          : ''}
        <button ?disabled="${this._aiBusy}" @click="${this._testAI}">Test connection</button>
      </div>
      ${this._aiMessage ? html`<p class="ai-message">${this._aiMessage}</p>` : ''}
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

  private _vModeButton(mode: VoiceMode, label: string, sub: string) {
    const selected = this._vMode === mode;
    return html`
      <button
        class="v-mode"
        role="radio"
        aria-checked="${selected ? 'true' : 'false'}"
        @click="${() => this._setVoiceMode(mode)}"
      >
        <span class="v-mark ${selected ? 'ok' : 'none'}" aria-hidden="true"
          >${selected ? '●' : '○'}</span
        >
        <span>
          ${label}
          <span class="v-mode-sub">${sub}</span>
        </span>
      </button>
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

      <label class="v-toggle">
        <input
          type="checkbox"
          .checked="${this._vEnabled}"
          @change="${(e: Event) => { this._vEnabled = (e.target as HTMLInputElement).checked; }}"
        />
        <span>Enable voice</span>
      </label>

      <p class="v-label">How voice signs in</p>
      <div class="v-modes" role="radiogroup" aria-label="How voice signs in">
        ${this._vModeButton('azure_entra', 'Azure OpenAI — Entra sign-in', 'Uses your signed-in identity. No key to store.')}
        ${this._vModeButton('azure_key', 'Azure OpenAI — access key', 'A key from your Azure OpenAI resource.')}
        ${this._vModeButton('openai_key', 'OpenAI — API key', 'A key from platform.openai.com.')}
      </div>

      ${isOpenAI
        ? html`
            <div class="v-field">
              <span class="v-label">Endpoint</span>
              <input class="ai-input" type="text" readonly .value="${OPENAI_ENDPOINT}" />
              <p class="v-hint">OpenAI has one endpoint, so it is fixed.</p>
            </div>
          `
        : html`
            <div class="v-field">
              <label class="v-label" for="v-endpoint">Endpoint</label>
              <input
                id="v-endpoint"
                class="ai-input"
                type="url"
                inputmode="url"
                autocomplete="off"
                spellcheck="false"
                placeholder="https://NAME.openai.azure.com/openai/v1"
                .value="${this._vEndpoint}"
                @input="${(e: Event) => { this._vEndpoint = (e.target as HTMLInputElement).value; }}"
              />
            </div>
          `}

      <div class="v-field">
        <label class="v-label" for="v-model">Model</label>
        <input
          id="v-model"
          class="ai-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="gpt-realtime-2.1-mini"
          .value="${this._vModel}"
          @input="${(e: Event) => { this._vModel = (e.target as HTMLInputElement).value; }}"
        />
      </div>

      ${isEntra
        ? html`
            <div class="v-field">
              <label class="v-label" for="v-scope">Entra scope</label>
              <select
                id="v-scope"
                class="ai-input"
                @change="${(e: Event) => { this._vScope = (e.target as HTMLSelectElement).value; }}"
              >
                ${(st.allowedScopes.length ? st.allowedScopes : [this._vScope]).map(
                  (s) => html`<option value="${s}" ?selected="${s === this._vScope}">${s}</option>`,
                )}
              </select>
              <p class="v-hint">
                The token audience. AI Foundry resources take the first; Cognitive
                Services resources take the second.
              </p>
            </div>
          `
        : html`
            <div class="v-field">
              <label class="v-label" for="v-key">${savedKeyApplies ? 'Replace key' : 'Key'}</label>
              <input
                id="v-key"
                class="ai-input"
                type="password"
                autocomplete="off"
                spellcheck="false"
                placeholder="${savedKeyApplies ? 'Leave blank to keep the saved key' : 'Paste the key'}"
                .value="${this._vKeyInput}"
                @input="${(e: Event) => { this._vKeyInput = (e.target as HTMLInputElement).value; }}"
              />
              <p class="v-hint">
                Write-only. Once saved it is never sent back to this page, so it can
                be replaced or removed but not read.
              </p>
            </div>
          `}

      <div class="v-actions">
        <button ?disabled="${this._voiceBusy}" @click="${this._saveVoice}">Save</button>
        <button ?disabled="${this._voiceBusy}" @click="${this._checkVoice}">Check sign-in</button>
        ${st.keySource === 'stored' && st.keyConfigured
          ? html`<button ?disabled="${this._voiceBusy}" @click="${this._clearVoiceKey}">Remove key</button>`
          : ''}
      </div>

      ${this._voiceMessage
        ? html`
            <p class="v-message">
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
        A key is stored at
        <code>${st.keyPath || '$XDG_CONFIG_HOME/muxterm/voice_api_key'}</code> with
        owner-only permissions, never in the config file. Saving rewrites only the
        <code>[voice]</code> section of
        <code>${st.configPath || '~/.config/muxterm/config.toml'}</code>; the rest of
        that file, including your comments, is left exactly as it is. Comments inside
        <code>[voice]</code> itself are replaced.
      </p>
    `;
  }

  // ── Agent credentials ────────────────────────────────────────────────────
  //
  // What a lane needs to run, on THIS machine. Separate from the AI section
  // above, which is muxterm's own Anthropic-powered features -- though the
  // Anthropic key is the same stored key, because there is one credential
  // store in the binary and adding a second is how one of them quietly stops
  // being the one that matters.

  private _emitCredentials(report: CredentialsReport): void {
    this._creds = report;
    // The host keeps the app-level notice in step from this one event; it
    // does not poll and does not have a second opinion about the machine.
    this.dispatchEvent(new CustomEvent('credentials-change', {
      detail: { report },
      bubbles: true,
      composed: true,
    }));
  }

  private async _loadCredentials(): Promise<void> {
    try {
      this._emitCredentials(await fetchCredentials());
    } catch {
      /* An unreadable report leaves the previous one on screen rather than
         replacing a true picture with a blank one. */
    }
  }

  private _setCredMsg(provider: string, msg: string): void {
    this._credMsg = { ...this._credMsg, [provider]: msg };
  }

  private async _saveCredential(p: ProviderState): Promise<void> {
    const key = (this._credInput[p.provider] ?? '').trim();
    if (!key || this._credBusy) return;
    this._credBusy = p.provider;
    this._setCredMsg(p.provider, `Checking the key with ${p.label}…`);
    try {
      const res = await saveCredential(p.provider, key);
      if (res.ok) {
        this._credInput = { ...this._credInput, [p.provider]: '' };
        this._emitCredentials(res.report);
        this._setCredMsg(
          p.provider,
          res.verdict.state === 'ok'
            ? `Saved. ${p.label} accepted it.`
            : res.verdict.state === 'unreachable'
              ? `Saved, but NOT verified: muxterm could not reach ${p.label}. Use Check now once you are back online.`
              : `Saved, but the check got an unexpected answer${res.verdict.httpStatus ? ` (HTTP ${res.verdict.httpStatus})` : ''} from ${p.baseURL}.`,
        );
        return;
      }
      if (res.error === 'rejected') {
        // Nothing was written. Say that outright: a user who is told "saved"
        // and then watches lanes die learns to distrust the whole surface.
        this._emitCredentials(res.report);
        this._setCredMsg(
          p.provider,
          `${p.label} rejected this key${res.verdict.httpStatus ? ` (HTTP ${res.verdict.httpStatus})` : ''}. It was NOT saved.`,
        );
        return;
      }
      this._setCredMsg(
        p.provider,
        res.error === 'invalid_key'
          ? 'That does not look like an API key. Nothing was saved.'
          : 'Could not save the key — it was not stored.',
      );
    } catch {
      this._setCredMsg(p.provider, 'Could not save the key — it was not stored.');
    } finally {
      this._credBusy = '';
    }
  }

  private async _clearCredential(p: ProviderState): Promise<void> {
    if (this._credBusy) return;
    this._credBusy = p.provider;
    this._setCredMsg(p.provider, '');
    try {
      const report = await clearCredential(p.provider);
      this._emitCredentials(report);
      const now = report.providers.find((x) => x.provider === p.provider);
      this._setCredMsg(
        p.provider,
        now?.present
          ? `Removed from muxterm. This machine still has one ${now.origin === 'environment' ? `in ${now.keyEnv}` : "in amplifier's keys.env"}, and lanes will use that.`
          : 'Removed.',
      );
    } catch {
      this._setCredMsg(p.provider, 'Could not remove the stored key.');
    } finally {
      this._credBusy = '';
    }
  }

  private async _checkCredential(p: ProviderState): Promise<void> {
    if (this._credBusy) return;
    this._credBusy = p.provider;
    this._setCredMsg(p.provider, `Asking ${p.label}…`);
    try {
      const res = await checkCredential(p.provider);
      this._emitCredentials(res.report);
      this._setCredMsg(p.provider, verdictMessage(p, res.verdict.state, res.verdict.httpStatus));
    } catch {
      this._setCredMsg(p.provider, 'The check could not be run.');
    } finally {
      this._credBusy = '';
    }
  }

  private _renderCredential(p: ProviderState) {
    const mark = credentialMarker(p);
    const busy = this._credBusy === p.provider;
    const msg = this._credMsg[p.provider] ?? '';
    return html`
      <div class="cred-block">
        <p class="cred-name">${p.label}</p>
        <div class="cred">
          <span class="cred-mark ${mark.tone}" aria-hidden="true">${mark.glyph}</span>
          <span class="cred-line">${credentialSentence(p)}</span>
          <p class="cred-sub">
            ${p.inMuxterm ? html`Stored in muxterm. ` : ''}
            ${p.inEnvironment ? html`${p.keyEnv} is set in muxterm's environment. ` : ''}
            ${p.inAmplifierFile ? html`Defined in amplifier's keys.env. ` : ''}
            ${p.present && (Number(p.inMuxterm) + Number(p.inEnvironment) + Number(p.inAmplifierFile)) > 1
              ? html`<br />More than one source — a lane uses the one named above.`
              : ''}
            <br />Endpoint: <code>${p.baseURL}</code>${p.baseURLOrigin === 'none' ? '' : ' (from this machine)'}
          </p>
        </div>
        <input
          class="ai-input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          aria-label="${p.label} API key"
          placeholder="${p.present ? 'Replace the key…' : 'Paste an API key…'}"
          .value="${this._credInput[p.provider] ?? ''}"
          @input="${(e: Event) => {
            this._credInput = {
              ...this._credInput,
              [p.provider]: (e.target as HTMLInputElement).value,
            };
          }}"
        />
        <div class="ai-actions">
          <button
            ?disabled="${busy || (this._credInput[p.provider] ?? '').trim() === ''}"
            @click="${() => void this._saveCredential(p)}"
          >Check and save</button>
          <button
            ?disabled="${busy || !p.present}"
            @click="${() => void this._checkCredential(p)}"
          >Check now</button>
          ${p.inMuxterm
            ? html`<button ?disabled="${busy}" @click="${() => void this._clearCredential(p)}">Remove</button>`
            : ''}
        </div>
        ${msg ? html`<p class="ai-message">${msg}</p>` : ''}
      </div>
    `;
  }

  private _renderAgents() {
    const c = this._creds;
    return html`
      <p class="section-title">Agent credentials</p>
      <div class="cred">
        <span class="cred-mark ${c.blocked ? 'err' : 'ok'}" aria-hidden="true">${c.blocked ? '!' : '✓'}</span>
        <span class="cred-line">
          ${c.blocked
            ? c.blockedReason
            : 'Lanes can run on this machine.'}
        </span>
      </div>
      <p class="ai-note">
        A lane is an <code>amplifier</code> or <code>claude</code> process muxterm starts
        for you. It needs a provider API key, and without a working one it fails on its
        first turn with the reason visible only in that pane's scrollback.
      </p>

      ${c.providers.map((p) => this._renderCredential(p))}

      <p class="ai-note">
        ${c.remoteGap}
      </p>
      <p class="ai-note">
        A key saved here is written to <code>${c.storeDir || '~/.config/muxterm'}</code> with
        owner-only permissions and handed to the agent processes muxterm starts, through
        their environment. muxterm never writes
        <code>${c.amplifierKeysPath || '~/.amplifier/keys.env'}</code> — that file belongs to
        amplifier${c.amplifierKeysFound ? ' and is read here only to report what it defines' : ' and was not found on this machine'}.
        A shell you open by hand does not get muxterm's stored keys; only the agent
        sessions muxterm launches do.
      </p>
      <p class="ai-note">
        Keys are write-only: once saved, no page and no API call can read one back — not
        masked, not the last four characters, not its length.
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
      <button
        class="r-btn danger"
        ?disabled="${this._pending.has(row.id)}"
        @click="${() => this._remove(row)}"
      >Remove</button>
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
        ${dropped ? html`<span class="r-state">reconnecting</span>` : ''}
        ${dropped
          ? html`<button
              class="r-btn"
              ?disabled="${busy}"
              @click="${() => this._retry(row)}"
            >Retry</button>`
          : html`<button
              class="r-btn danger"
              ?disabled="${busy}"
              @click="${() => this._disconnect(row)}"
            >Disconnect</button>`}
        ${this._renderRemoveBtn(row)}
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
          <button
            class="r-btn"
            ?disabled="${busy}"
            @click="${() => this._retry(row)}"
          >Retry</button>
          ${this._renderRemoveBtn(row)}
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
        ${install
          ? html`<button
              class="r-btn"
              ?disabled="${busy}"
              @click="${() => this._provision(row)}"
            >Install &amp; connect</button>`
          : html`<button
              class="r-btn pri"
              ?disabled="${busy}"
              @click="${() => this._connect(row)}"
            >Connect</button>`}
        ${this._renderRemoveBtn(row)}
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
      ${this._remotesError ? html`<div class="r-error">${this._remotesError}</div>` : ''}
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
      <input
        class="ai-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="user@host"
        .value="${this._addTarget}"
        @input="${(e: Event) => { this._addTarget = (e.target as HTMLInputElement).value; }}"
        @keydown="${(e: KeyboardEvent) => { if (e.key === 'Enter') void this._addHost(); }}"
      />
      ${this._addError ? html`<div class="r-error">${this._addError}</div>` : ''}
    `;
  }

  override render() {
    if (!this.config) return html``;

    return html`
      <div class="header">
        <h2>Settings</h2>
        <button class="close-btn" title="Close" @click="${this._close}">×</button>
      </div>
      <div class="body">
        <nav class="sidebar">
          <button
            class="sidebar-item ${this._section === 'appearance' ? 'active' : ''}"
            @click="${() => { this._section = 'appearance'; }}"
          >Appearance</button>
          <button
            class="sidebar-item ${this._section === 'notifications' ? 'active' : ''}"
            @click="${() => { this._section = 'notifications'; }}"
          >Notifications</button>
          <button
            class="sidebar-item ${this._section === 'agents' ? 'active' : ''}"
            @click="${() => { this._section = 'agents'; void this._loadCredentials(); }}"
          >Agents</button>
          <button
            class="sidebar-item ${this._section === 'ai' ? 'active' : ''}"
            @click="${() => { this._section = 'ai'; }}"
          >AI</button>
          <button
            class="sidebar-item ${this._section === 'voice' ? 'active' : ''}"
            @click="${() => { this._section = 'voice'; void this._loadVoice(); }}"
          >Voice</button>
          <button
            class="sidebar-item ${this._section === 'remotes' ? 'active' : ''}"
            @click="${() => { this._section = 'remotes'; void this._loadRemotes(); }}"
          >Remotes</button>
        </nav>
        <div class="content">
          ${this._section === 'appearance'
            ? this._renderAppearance()
            : this._section === 'notifications'
              ? this._renderNotifications()
              : this._section === 'remotes'
                ? this._renderRemotes()
                : this._section === 'voice'
                  ? this._renderVoice()
                  : this._section === 'agents'
                    ? this._renderAgents()
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
