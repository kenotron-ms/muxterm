import { LitElement, css, html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { customElement, property, state } from 'lit/decorators.js';
import { MarkdownStream } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import { chatMarkdownPolicy } from '../lib/chat-markdown-policy.js';
import '../lib/mermaid-diagram.js';
import { sdkChats, type SDKChat } from '../lib/sdk-chats.js';
import { apiPath } from '../lib/base-path.js';
import { fetchVoiceStatus } from '../lib/voice-settings.js';
import { SDKVoiceSession, type SDKVoiceState } from '../lib/sdk-voice-session.js';
import './mux-sdk-chat-settings.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import './mux-sdk-utility.js';
import type { MuxSDKUtility } from './mux-sdk-utility.js';

type DisplayAttachment = { id: string; name: string; kind: string };
type SDKEvent = { at?: string; complete?: boolean; childSessionId?: string; parentSessionId?: string; agent?: string; type: string; text?: string; name?: string; toolId?: string; inputId?: string; inputIds?: string[]; generationId?: string; message?: string; kind?: string; source?: string; raw?: unknown; failed?: boolean; summary?: boolean; attachments?: DisplayAttachment[]; goalState?: string; goalReason?: string; goalSummary?: string };
type AgentLeg = { task: string; reply: string; status: string };
type AgentStep = { id: string; name: string; status: string; detail?: unknown };
type AgentView = { id: string; parentId: string; name: string; status: string; progress: string; legs: AgentLeg[]; steps: AgentStep[]; startedAt?: number; finishedAt?: number };
type Block = { key: number; turn: number; kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'delegate' | 'progress' | 'error' | 'status'; text: string; channel?: 'voice' | 'task'; name?: string; id?: string; done?: boolean; input?: unknown; output?: unknown; failed?: boolean; summary?: boolean; attachments?: DisplayAttachment[] };
type ToolKind = 'shell' | 'read' | 'search' | 'web' | 'edit' | 'agent' | 'other';
type HistoryPage = { from: number; to: number; hasMore: boolean; events: SDKEvent[] };
type TranscriptRow = { key: string; block: Block; work?: Block[] };
type CachedTranscript = { blocks: Block[]; chat?: SDKChat };
const transcriptCache = new Map<string, CachedTranscript>();
const transcriptCacheKey = (id: string) => `muxterm-chat-transcript:${id}`;
function readTranscriptCache(id: string): CachedTranscript | undefined {
  const memory = transcriptCache.get(id);
  if (memory) return memory;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(transcriptCacheKey(id)) || 'null') as CachedTranscript | null;
    if (parsed && (!parsed.chat || parsed.chat.id === id) && Array.isArray(parsed.blocks) && parsed.blocks.every(block =>
      (block.kind === 'user' || block.kind === 'assistant') && typeof block.text === 'string' &&
      Number.isSafeInteger(block.turn) && Number.isSafeInteger(block.key))) {
      transcriptCache.set(id, parsed);
      return parsed;
    }
  } catch { /* storage can be unavailable */ }
  return undefined;
}
import { icon } from '../lib/icons.js';
import { BookOpen, Bot, Brain, ChevronDown, ChevronRight, Columns2, FilePenLine, Globe, Mic, PanelLeft, PanelRight, Search, Terminal, Wrench, type IconNode } from 'lucide';

type Attachment = { localId: string; file: File; id?: string; kind?: string; preview?: string; error?: string; uploading: boolean };
@customElement('mux-sdk-chat')
export class MuxSDKChat extends LitElement {
  @property() sessionId = '';
  @state() private chat?: SDKChat;
  @state() private scheduledJob?: { name:string };
  @state() private blocks: Block[] = [];
  @state() private trajectory: SDKEvent[] = [];
  @state() private agentEvents: SDKEvent[] | null = null;
  @state() private agentHistoryError = '';
  @state() private selectedAgent = '';
  @state() private agentDraft = '';
  @state() private agentNotice = '';
  @state() private recoveryRequired = false;
  @state() private recoveryPrepared = false;
  @state() private draft = '';
  @state() private error = '';
  @state() private busy = false;
  @state() private stopping = false;
  @state() private drawerOpen = false;
  @state() private previewFocused = false;
  @state() private drawerWidth = 0;
  private resizingDrawer = false;
  @state() private attachments: Attachment[] = [];
  @state() private dropActive = false;
  @state() private settingsPending = false;
  @state() private voiceAvailable = false;
  @state() private voiceState: SDKVoiceState = 'idle';
  private voice?: SDKVoiceSession;
  @state() private showScrollBottom = false;
  private dragDepth = 0;
  private stream?: EventSource;
  private reconnectTimer?: number;
  private cacheTimer?: number;
  private streamCursor = 0;
  private reconnectFailures = 0;
  private streamOpenedAt = 0;
  @state() private reconnectFailed = false;
  private idleSuspended = false;
  private lastActivationAt = Date.now();
  private historyAbort?: AbortController;
  private historyEpoch = 0;
  private activeSession = '';
  private historyFrom = 0;
  private historyTo = 0;
  @state() private hasOlder = false;
  @state() private loadingOlder = false;
  @state() private loadingDetails = false;
  private loadedEvents: SDKEvent[] = [];
  private liveEvents: SDKEvent[] = [];
  private detailsLoaded = false;
  private replaying = false;
  private fillingRecent = false;
  private restoringScroll = false;
  private historyUserInteracted = false;
  private olderTask?: Promise<boolean>;
  private rowHeights = new Map<string, number>();
  private rowsCache?: { blocks: Block[]; rows: TranscriptRow[] };
  @state() private visibleStart = 0;
  @state() private visibleEnd = 0;
  private rowObserver = new ResizeObserver(entries => {
    let changed = false;
    for (const entry of entries) {
      const row = entry.target as HTMLElement;
      const key = row.dataset.rowKey;
      if (!key) continue;
      const height = entry.borderBoxSize?.[0]?.blockSize || row.offsetHeight;
      if (Math.abs((this.rowHeights.get(key) || 110) - height) > 2) { this.rowHeights.set(key, height); changed = true; }
    }
    if (changed) this.requestUpdate();
  });
  private unsubscribeChats?: () => void;
  private parsers = new Map<number, MarkdownStream>();
  private preventFileNavigation = (event: DragEvent) => { if (this.hasFiles(event)) event.preventDefault(); };
  private readonly stopVoiceOnEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.voiceState !== 'idle') {
      event.preventDefault();
      this.voice?.stop();
    }
  };
  private resetDrop = () => { this.dragDepth = 0; this.dropActive = false; };
  private workExpanded = new Set<number>();
  private stepExpanded = new Set<string>();
  private turnStarted = new Map<number, number>();
  private turnFinished = new Map<number, number>();
  private currentTurn = 0;
  @state() private now = Date.now();
  private clock?: ReturnType<typeof setInterval>;
  private nextBlockKey = 0;
  private turnStart = 0;
  private completedInputAnchors = new Map<string, number>();
  private pendingInputs = new Map<string, number>();
  private parentScrollTop = 0;
  static styles = css`
    ${subtleScrollbars}
    :host { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column; background:var(--chrome-body); color:var(--chrome-text-bright,#d9def0); font:13px/1.55 system-ui,sans-serif; }
    .topbar { box-sizing:border-box; height:42px; flex:none; display:flex; align-items:center; gap:12px; padding:0 12px 0 22px; border-bottom:1px solid var(--chrome-border,#343a4c); }
    .breadcrumbs { display:flex; align-items:center; gap:7px; min-width:0; }
    .breadcrumbs button { border:0; padding:4px; border-radius:5px; background:transparent; color:var(--chrome-accent); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:240px; }
    .breadcrumbs button:hover { background:var(--chrome-hover); }
    .agent-history-error { align-self:center; width:calc(100% - 48px); max-width:760px; box-sizing:border-box; padding:7px 0; color:var(--chrome-danger); font-size:12px; }
    .agent-history-error button { border:0; padding:2px 4px; background:transparent; color:var(--chrome-accent); }
    .agent-history-error button:hover { text-decoration:underline; }
    .delegate-card { box-sizing:border-box; display:grid; grid-template-columns:18px minmax(0,1fr) auto; align-items:center; gap:9px; width:100%; max-width:560px; min-height:54px; border:1px solid var(--chrome-border,#41485f); border-radius:9px; padding:7px 10px; background:var(--chrome-bar,#222b3c); color:var(--chrome-text-bright,#d9def0); text-align:left; }
    .delegate-card:hover { border-color:color-mix(in srgb,var(--chrome-accent,#9bb8f7) 45%,var(--chrome-border,#41485f)); background:color-mix(in srgb,var(--chrome-bar,#222b3c) 90%,var(--chrome-accent,#9bb8f7)); }
    .delegate-card:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .delegate-icon { display:inline-flex; color:var(--chrome-accent,#9bb8f7); }
    .delegate-copy { display:flex; flex-direction:column; min-width:0; gap:2px; }
    .delegate-name { font-size:12px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .delegate-task { color:var(--chrome-text-dim,#aabbd6); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .delegate-meta { display:flex; align-items:center; align-self:start; gap:8px; min-height:18px; color:var(--chrome-text-dim,#9aa3b8); font-size:11px; font-variant-numeric:tabular-nums; }
    .delegate-status-dot { width:7px; height:7px; border-radius:50%; background:var(--mux-ok); }
    .delegate-status-dot.running { background:var(--chrome-accent); box-shadow:0 0 0 3px color-mix(in srgb,var(--chrome-accent) 14%,transparent); }
    .delegate-status-dot.failed { background:var(--chrome-danger); }
    .delegate-chevron { display:inline-flex; opacity:.75; }
    .agent-chat { max-width:760px; width:100%; align-self:center; }
    .agent-chat .instruction { padding:13px 16px; border-radius:15px; background:color-mix(in srgb,var(--chrome-accent) 16%,var(--chrome-body)); margin:10px 0 24px auto; max-width:82%; white-space:pre-wrap; }
    .agent-chat .reply { padding:13px 16px; border-radius:12px; background:var(--chrome-bar); white-space:pre-wrap; }
    .agent-chat .reply pre { white-space:pre-wrap; overflow-wrap:anywhere; }
    .agent-step { margin:12px 0; padding:10px 12px; border:1px solid var(--chrome-border); border-radius:9px; background:var(--chrome-bar); }
    .agent-step pre { margin:6px 0 0; max-height:300px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.5 ui-monospace,monospace; }
    .agent-notice { color:var(--chrome-text-dim); font-size:12px; }
    .recovery { max-width:760px; width:calc(100% - 48px); box-sizing:border-box; align-self:center; margin:12px auto 0; padding:12px 14px; border:1px solid color-mix(in srgb,var(--mux-warn) 55%,var(--chrome-border)); border-radius:9px; background:color-mix(in srgb,var(--mux-warn) 10%,var(--chrome-body)); color:var(--chrome-text-bright); }
    .recovery strong { display:block; margin-bottom:3px; }
    .recovery p { margin:0 0 9px; }
    .recovery button { border:1px solid var(--mux-warn); border-radius:6px; padding:5px 9px; background:color-mix(in srgb,var(--mux-warn) 15%,var(--chrome-bar)); color:var(--chrome-text-bright); }
    .recovery button:hover { background:color-mix(in srgb,var(--mux-warn) 25%,var(--chrome-bar)); }
    h1 { font-size:14px; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    button { font:inherit; cursor:pointer; }
    .pane-controls { display:inline-flex; align-items:center; flex:none; margin-left:auto; border:1px solid var(--chrome-border); border-radius:8px; padding:2px; background:var(--chrome-bar); }
    .pane-controls button { display:grid; place-items:center; width:29px; height:27px; border:0; border-radius:6px; background:transparent; color:var(--chrome-text-dim); padding:0; cursor:pointer; }
    .pane-controls button:hover,.pane-controls button:focus-visible { color:var(--chrome-text-bright); background:var(--chrome-hover); outline:none; }
    .pane-controls button.active { color:var(--chrome-accent); background:var(--chrome-hover); }
    .chat-title { min-width:0; overflow:hidden; }
    .chat-title small { display:block; color:var(--chrome-text-dim); font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .layout { display:flex; flex:1; min-height:0; }
    .layout.preview-focused .chat { display:none; }
    .layout.preview-focused .drawer { width:100%; flex:1; border-left:0; }
    .layout.preview-focused .drawer-resizer { display:none; }
    .chat { flex:1; min-width:0; display:flex; flex-direction:column; }
    .body { flex:1; min-height:0; overflow:auto; padding:36px 24px 48px; display:flex; flex-direction:column; scrollbar-gutter:stable both-edges; overflow-anchor:none; }
    .scroll-bottom-row { position:relative; z-index:2; height:0; }
    .scroll-bottom { position:absolute; left:50%; bottom:12px; transform:translateX(-50%); border:1px solid var(--chrome-border,#41485f); border-radius:999px; padding:7px 13px; background:var(--chrome-bar,#202632); color:var(--chrome-text-bright,#d9def0); box-shadow:0 4px 16px #0006; white-space:nowrap; }
    .virtual-spacer { width:1px; flex:none; pointer-events:none; }
    .block { max-width:760px; width:100%; align-self:center; margin-bottom:28px; box-sizing:border-box; }
    .block.work { margin-top:-12px; margin-bottom:20px; }
    .work-disclosure > summary { display:flex; align-items:center; gap:7px; min-height:25px; padding:0 0 7px; border-bottom:1px solid color-mix(in srgb,var(--chrome-border,#41485f) 58%,transparent); color:var(--chrome-text-dim,#9aa3b8); font-size:12px; list-style:none; cursor:pointer; }
    .work-disclosure .activity-label { flex:none; }
    .work-disclosure .pulse { width:7px; height:7px; flex:none; border-radius:50%; background:var(--chrome-accent); box-shadow:0 0 0 3px color-mix(in srgb,var(--chrome-accent) 14%,transparent); animation:activity-pulse 1.35s ease-in-out infinite; }
    @keyframes activity-pulse { 50% { opacity:.35; transform:scale(.7); } }
    @media (prefers-reduced-motion:reduce) { .work-disclosure .pulse { animation:none; } }
    .work-disclosure > summary::-webkit-details-marker { display:none; }
    .work-disclosure > summary:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; border-radius:4px; }
    .work-disclosure > summary svg { opacity:.7; transition:transform .15s ease; }
    .work-disclosure[open] > summary svg { transform:rotate(180deg); }
    .work-items { padding:12px 0 2px; }
    .work-item { margin-bottom:5px; }
    .user { display:flex; justify-content:flex-end; }
    .bubble { max-width:min(82%,660px); padding:10px 15px; border-radius:17px; background:color-mix(in srgb,var(--chrome-accent) 14%,var(--chrome-body)); white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; line-height:1.55; }
    .bubble img { display:block; max-width:min(100%,240px); max-height:180px; border-radius:9px; margin-top:8px; object-fit:contain; }
    .bubble a { display:block; margin-top:7px; color:var(--chrome-accent); }
    .speaker { color:var(--chrome-text-dim,#9aa3b8); font-size:12px; font-weight:600; margin-bottom:10px; text-transform:capitalize; }
    .text { color:var(--chrome-text-bright,#d9def0); font-size:14px; line-height:1.68; overflow-wrap:anywhere; }
    .text > :first-child { margin-top:0; }
    .text > :last-child { margin-bottom:0; }
    .text .md-p { margin:0 0 15px; }
    .text .md-h { line-height:1.32; margin:25px 0 11px; font-weight:650; color:var(--chrome-text-bright,#d9def0); }
    .text h1.md-h { font-size:1.45em; }
    .text h2.md-h { font-size:1.25em; }
    .text h3.md-h { font-size:1.12em; }
    .text h4.md-h, .text h5.md-h, .text h6.md-h { font-size:1em; }
    .text strong { color:var(--chrome-text-bright,#d9def0); font-weight:700; }
    .text .md-code { padding:.13em .38em; border:1px solid var(--chrome-border,#41485f); border-radius:5px; background:var(--chrome-bar,#202632); font: .91em/1.4 ui-monospace,monospace; }
    .text .md-pre { box-sizing:border-box; max-width:100%; overflow:auto; margin:0 0 18px; padding:16px 18px; border:1px solid var(--chrome-border,#41485f); border-radius:12px; background:var(--chrome-bar,#202632); }
    .text .md-pre[data-lang]:not([data-lang=""])::before { content:attr(data-lang); display:block; margin:-4px 0 12px; color:var(--chrome-text-dim,#9aa3b8); font:11px/1.4 system-ui,sans-serif; text-transform:uppercase; letter-spacing:.04em; }
    .text .md-pre code { color:inherit; font:12.5px/1.6 ui-monospace,monospace; white-space:pre; }
    .text .md-pre[data-streaming] { border-bottom-color:var(--chrome-accent,#9bb8f7); }
    .text .md-link { color:var(--chrome-accent,#9bb8f7); text-decoration:underline; text-underline-offset:3px; }
    .text .md-image-link { display:inline-block; max-width:100%; }
    .text .md-img { display:block; max-width:100%; max-height:min(420px,55vh); width:auto; height:auto; object-fit:contain; border:1px solid var(--chrome-border,#41485f); border-radius:8px; }
    .text .md-ul, .text .md-ol { margin:0 0 16px; padding-left:25px; }
    .text .md-li { margin:5px 0; }
    .text .md-li .md-p { margin:0; }
    .text .md-quote { margin:0 0 16px; padding-left:15px; border-left:2px solid var(--chrome-border,#41485f); color:var(--chrome-text-dim,#9aa3b8); }
    .text .md-hr { margin:24px 0; border:0; border-top:1px solid var(--chrome-border,#41485f); }
    .text .md-tablewrap { max-width:100%; min-width:0; overflow-x:auto; margin:0 0 18px; }
    .text .md-table { border-collapse:collapse; min-width:max(100%, 40rem); }
    .text .md-th, .text .md-td { padding:8px 12px; border:1px solid var(--chrome-border,#41485f); text-align:left; vertical-align:top; overflow-wrap:break-word; word-break:normal; }
    .text .md-table .md-link, .text .md-table .md-code { overflow-wrap:break-word; }
    .text .md-th { background:var(--chrome-bar,#202632); }
    .thinking-entry, .tool-activity, .tool-entry { color:var(--chrome-text-dim,#9aa3b8); font-size:12px; }
    .thinking-entry > summary, .tool-activity > summary, .tool-entry > summary { display:flex; align-items:center; gap:8px; min-height:27px; list-style:none; cursor:pointer; }
    .thinking-entry > summary::-webkit-details-marker, .tool-activity > summary::-webkit-details-marker, .tool-entry > summary::-webkit-details-marker { display:none; }
    .thinking-entry > summary:focus-visible, .tool-activity > summary:focus-visible, .tool-entry > summary:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; border-radius:4px; }
    .thinking-entry > summary:hover, .tool-activity > summary:hover, .tool-entry > summary:hover { color:var(--chrome-text-bright,#d9def0); }
    .work-icon { display:inline-flex; align-items:center; justify-content:center; width:16px; flex:none; }
    .work-line { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .thinking-entry .work-line { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; white-space:normal; overflow-wrap:anywhere; line-height:1.45; }
    .work-chevron { display:inline-flex; flex:none; opacity:.65; transition:transform .15s ease; }
    .thinking-entry[open] > summary .work-chevron, .tool-activity[open] > summary .work-chevron, .tool-entry[open] > summary .work-chevron { transform:rotate(180deg); }
    .thinking-entry .detail { margin:4px 0 9px 24px; padding:0 0 0 10px; border-left:1px solid var(--chrome-border,#41485f); }
    .tool-activity { margin:5px 0 7px; }
    .tool-activity-items { margin:2px 0 0 2px; }
    .tool-entry > summary { padding-left:22px; }
    .tool-entry.failed > summary { color:var(--chrome-danger); }
    .tool-entry .detail { box-sizing:border-box; max-width:min(100%,650px); margin:5px 0 11px 23px; padding:10px 12px 12px; border:1px solid var(--chrome-border,#41485f); border-radius:9px; background:color-mix(in srgb,var(--chrome-accent) 5%,var(--chrome-body)); }
    .tool-detail-title { color:var(--chrome-text-bright,#d9def0); font-size:12px; font-weight:600; }
    .detail-label { color:var(--chrome-accent); font-weight:600; margin:9px 0 4px; }
    .detail pre { margin:0; padding:8px 10px; border-radius:6px; background:var(--chrome-bar); white-space:pre-wrap; overflow-wrap:anywhere; max-height:420px; overflow:auto; color:var(--chrome-text-bright,#d9def0); font:12px/1.5 ui-monospace,monospace; }
    .error { color:var(--chrome-danger); }
    /* Offset the composer's text inset against the transcript's narrow-width gutter. */
    .composer-wrap { padding:0 19px 18px; }
    .attachments { display:flex; flex-wrap:wrap; gap:8px; padding:0 0 11px; }
    .attachment { position:relative; display:flex; align-items:center; gap:9px; min-width:0; max-width:min(100%,230px); padding:5px 28px 5px 5px; border:1px solid var(--chrome-border,#41485f); border-radius:10px; background:var(--chrome-bar,#202632); }
    .attachment img { flex:none; width:52px; height:52px; object-fit:cover; border-radius:6px; background:var(--chrome-body); }
    .attachment .filename { min-width:0; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
    .attachment .status { color:var(--chrome-text-dim,#9aa3b8); font-size:11px; }
    .attachment .status.failed { color:var(--chrome-danger); }
    .attachment button { position:absolute; top:4px; right:4px; width:22px; height:22px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--chrome-text-dim,#9aa3b8); font-size:18px; line-height:20px; }
    .attachment button:hover { background:var(--chrome-hover); color:inherit; }
    .attach-button { flex:none; width:34px; height:34px; display:grid; place-items:center; border:0; border-radius:9px; padding:0; background:transparent; color:var(--chrome-text-bright,#d9def0); }
    .attach-button svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
    .attach-button:hover, .attach-button:focus-visible { background:var(--chrome-bar,#202632); outline:none; }
    .file-input { display:none; }
    .drop-overlay { position:absolute; inset:8px; z-index:10; display:grid; place-items:center; border:2px dashed var(--chrome-accent); border-radius:16px; background:color-mix(in srgb,var(--chrome-body) 92%,transparent); color:var(--chrome-text-bright); font-size:22px; pointer-events:none; }
    /* The border extends 15px beyond each 760px transcript edge so typed text aligns with replies. */
    .composer { box-sizing:border-box; max-width:790px; margin:auto; border:1px solid var(--chrome-border,#41485f); border-radius:18px; background:var(--chrome-bar,#202632); padding:13px 14px 9px; box-shadow:0 8px 28px rgba(0,0,0,.08); transition:border-color .15s,box-shadow .15s; }
    .composer:focus-within { border-color:color-mix(in srgb,var(--chrome-accent,#9bb8f7) 58%,var(--chrome-border,#41485f)); box-shadow:0 0 0 2px color-mix(in srgb,var(--chrome-accent,#9bb8f7) 14%,transparent); }
    .composer-row { display:flex; }
    .composer-controls { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-top:7px; min-height:34px; }
    .composer-controls .send, .composer-controls .stop { margin-left:auto; }
    textarea { display:block; flex:1; min-width:0; resize:none; border:0; outline:none; background:transparent; color:inherit; font:14px/1.55 system-ui,sans-serif; min-height:34px; height:34px; max-height:220px; padding:3px 0; box-sizing:border-box; overflow-y:auto; }
    textarea::placeholder { color:var(--chrome-text-dim,#9aa3b8); opacity:.8; }
    .send, .stop { flex:none; width:34px; height:34px; display:grid; place-items:center; border-radius:10px; }
    .send { border:0; background:var(--chrome-accent,#9bb8f7); color:var(--chrome-body); font-size:20px; line-height:1; }
    .send:hover:not(:disabled) { filter:brightness(1.1); }
    .send:disabled { opacity:.38; cursor:default; }
    .voice-text { white-space:pre-wrap; overflow-wrap:anywhere; }
    .send-icon { display:grid; place-items:center; animation:send-icon-in .18s ease-out both; }
    @keyframes send-icon-in { from { opacity:0; } to { opacity:1; } }
    .send.voice-active { width:78px; font-size:13px; font-weight:650; }
    .send.voice-active .send-icon { display:flex; align-items:center; gap:6px; }
    .voice-bars { display:inline-flex; align-items:center; justify-content:center; gap:2px; height:16px; }
    .voice-bars i { display:block; width:2px; border-radius:99px; background:currentColor; transition:height .075s ease-out; }
    .voice-bars i:nth-child(1) { height:6px; }
    .voice-bars i:nth-child(2) { height:13px; }
    .voice-bars i:nth-child(3) { height:8px; }
    .voice-bars i:nth-child(4) { height:16px; }
    .voice-bars i:nth-child(5) { height:10px; }
    .voice-compose-row { min-height:34px; display:flex; align-items:center; gap:9px; color:var(--chrome-text-dim,#9aa3b8); }
    .voice-compose-row .voice-label { flex:1; font-size:14px; }
    .voice-compose-row .voice-mic { font-size:18px; line-height:1; }
    .voice-compose-row .voice-attach { flex:none; width:30px; height:30px; border:0; background:transparent; color:inherit; font-size:22px; line-height:1; }
    @media (prefers-reduced-motion:reduce) { .voice-bars i { transition:none; } .send-icon { animation:none; } }
    .stop { border:1px solid var(--chrome-danger); background:var(--chrome-danger); color:var(--chrome-body); font-size:15px; }
    .stop:hover:not(:disabled) { background:color-mix(in srgb,var(--chrome-danger) 85%,var(--chrome-text-bright)); }
    .stop:disabled { opacity:.6; }
    .steer { margin-left:auto; border:1px solid var(--chrome-border,#41485f); border-radius:9px; background:transparent; color:var(--chrome-text-bright,#d9def0); padding:6px 10px; }
    .steer + .stop { margin-left:0; }
    .composer button:focus-visible { outline:2px solid var(--chrome-accent,#9bb8f7); outline-offset:2px; }
    .status { color:color-mix(in srgb,var(--mux-warn) 70%,var(--chrome-text-bright)); font-size:12px; }
    .drawer { position:relative; flex:none; width:var(--utility-width); min-width:0; border-left:1px solid var(--chrome-border,#343a4c); background:var(--chrome-bar,#202632); animation:drawer-in .16s ease-out; }
    .drawer-resizer { position:absolute; z-index:2; left:-5px; top:0; bottom:0; width:10px; cursor:col-resize; touch-action:none; }
    .drawer-resizer:hover, .drawer-resizer:focus-visible { background:color-mix(in srgb,var(--chrome-accent) 25%,transparent); outline:none; }
    @keyframes drawer-in { from { transform:translateX(18px); opacity:.55; } to { transform:translateX(0); opacity:1; } }
    @media(max-width:700px) { .body { padding:24px 16px 32px; } .composer-wrap { padding:0 11px 12px; } .drawer { position:absolute; right:0; top:42px; bottom:0; box-shadow:-10px 0 30px #0008; } .layout.preview-focused .drawer { left:0; box-shadow:none; } .topbar { padding-left:10px; gap:6px; } }
  `;
  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('focus', this.resumeConnection);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('pageshow', this.resumeConnection);
    window.addEventListener('keydown', this.stopVoiceOnEscape);
    window.addEventListener('dragover', this.preventFileNavigation);
    window.addEventListener('drop', this.preventFileNavigation);
    window.addEventListener('drop', this.resetDrop);
    window.addEventListener('dragend', this.resetDrop);
    window.addEventListener('pagehide', this.persistTranscriptCache);
    this.unsubscribeChats = sdkChats.subscribe(() => {
      const updated = sdkChats.chats.find(chat => chat.id === this.sessionId);
      if (updated) {
        this.chat = updated;
        this.recoveryRequired = updated.state === 'uncertain';
      }
      this.requestUpdate();
    });
    this.clock = setInterval(() => { if (this.busy) this.now = Date.now(); }, 1000);
    this.connect();
    void fetchVoiceStatus().then(status => { this.voiceAvailable = status.enabled && !status.restartRequired; });
  }
  override disconnectedCallback() {
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('focus', this.resumeConnection);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('pageshow', this.resumeConnection);
    window.removeEventListener('keydown', this.stopVoiceOnEscape);
    this.persistTranscriptCache();
    window.removeEventListener('pagehide', this.persistTranscriptCache);
    window.removeEventListener('dragover', this.preventFileNavigation);
    window.removeEventListener('drop', this.preventFileNavigation);
    window.removeEventListener('drop', this.resetDrop);
    window.removeEventListener('dragend', this.resetDrop);
    this.unsubscribeChats?.();
    if (this.clock) clearInterval(this.clock);
    this.historyEpoch++;
    this.historyAbort?.abort();
    this.stream?.close();
    this.voice?.stop();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.rowObserver.disconnect();
    this.activeSession = '';
    for (const a of this.attachments) if (a.preview) URL.revokeObjectURL(a.preview);
    super.disconnectedCallback();
  }
  private readonly onVisibilityChange = () => {
    if (!document.hidden) { this.resumeConnection(); return; }
    this.idleSuspended = true;
    this.historyEpoch++;
    this.historyAbort?.abort();
    this.stream?.close(); this.stream = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectFailures = 0;
    if (this.reconnectFailed) { this.reconnectFailed = false; this.error = ''; }
  };
  private readonly resumeConnection = () => {
    const away = Date.now() - this.lastActivationAt;
    this.lastActivationAt = Date.now();
    if (!this.isConnected || !this.activeSession || document.hidden) return;
    // A sleeping browser may resume without a visibility change or an SSE error.
    if (this.idleSuspended || this.reconnectFailed || away > 60_000 || (this.reconnectFailures > 0 && !this.reconnectTimer)) {
      this.idleSuspended = false;
      this.retryConnection();
    }
  };
  private readonly onOnline = () => {
    if (!this.isConnected || !this.activeSession || document.hidden) return;
    this.idleSuspended = false;
    this.retryConnection();
  };
  override willUpdate(changed: Map<string, unknown>) { if (changed.has('sessionId')) { this.connect(); void this.loadScheduledJob(); } }
  private async loadScheduledJob() {
    const id = this.sessionId;
    this.scheduledJob = undefined;
    if (!id) return;
    try {
      const response = await fetch(apiPath('/api/sdk-jobs'));
      if (!response.ok) return;
      const jobs = await response.json() as { chatId:string; name:string }[];
      if (this.sessionId === id) this.scheduledJob = jobs.find(job => job.chatId === id);
    } catch { /* Chat remains usable if job metadata is unavailable. */ }
  }
  override updated(changed: Map<string, unknown>) {
    if (changed.has('draft')) this.sizeTextarea();
    this.rowObserver.disconnect();
    this.shadowRoot?.querySelectorAll<HTMLElement>('[data-row-key]').forEach(row => this.rowObserver.observe(row));
  }
  private sizeTextarea() {
    const textarea = this.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) return;
    textarea.style.height = '34px';
    textarea.style.height = `${Math.min(220, Math.max(34, textarea.scrollHeight))}px`;
  }
  private drawerKey() { return `muxterm.sdk.utility.width.${this.sessionId}`; }
  private widthLimits() {
    const available = this.shadowRoot?.querySelector<HTMLElement>('.layout')?.clientWidth || this.clientWidth || window.innerWidth;
    return { min: Math.min(280, available * .6), max: available <= 700 ? available * .9 : Math.max(280, available - 480), available };
  }
  private openDrawer() {
    if (this.drawerOpen) { this.drawerOpen = false; this.previewFocused = false; return; }
    const { min, max, available } = this.widthLimits();
    let stored = 0;
    try { stored = Number(localStorage.getItem(this.drawerKey())) || 0; } catch { /* private browsing */ }
    this.drawerWidth = Math.round(Math.max(min, Math.min(max, stored || available / 2)));
    this.drawerOpen = true;
  }
  private setPaneMode(mode: 'chat' | 'split' | 'preview') {
    if (mode === 'chat') { this.drawerOpen = false; this.previewFocused = false; return; }
    if (!this.drawerOpen) this.openDrawer();
    this.previewFocused = mode === 'preview';
  }
  /** Apply a server-relayed request after this chat is on screen. */
  async navigateUI(action: 'chat' | 'panel' | 'tab' | 'file', mode?: string, tab?: string, path?: string): Promise<void> {
    if (action === 'chat') return;
    if (action === 'panel') {
      if (mode === 'chat' || mode === 'split') this.setPaneMode(mode);
      return;
    }
    this.setPaneMode('split');
    await this.updateComplete;
    const utility = this.shadowRoot?.querySelector<MuxSDKUtility>('mux-sdk-utility');
    if (action === 'file' && path) await utility?.showFile(path);
    else if (action === 'tab' && (tab === 'files' || tab === 'changes' || tab === 'terminal' || tab === 'pages')) utility?.showPanel(tab);
  }
  private stageFileReference(event: CustomEvent<{ path: string; selected?: string }>) {
    const { path, selected } = event.detail;
    this.selectedAgent = '';
    this.setPaneMode('split');
    const reference = `@${path}${selected ? `\n> ${selected.replaceAll('\n', '\n> ')}` : ''}`;
    this.draft = this.draft.trimEnd() ? `${this.draft.trimEnd()}\n${reference}\n` : `${reference}\n`;
    void this.updateComplete.then(() => this.shadowRoot?.querySelector<HTMLTextAreaElement>('.composer-row textarea')?.focus());
  }
  private stagePagePrompt(event: CustomEvent<{ pageId: string; title: string; kind: 'generate' | 'visualize' }>) {
    this.selectedAgent = '';
    this.setPaneMode('split');
    const request = event.detail.kind === 'visualize'
      ? `Create an interactive visualization for the page "${event.detail.title}" (page ID ${event.detail.pageId}) using muxterm's add_page_visualization tool. Choose meaningful numeric data, include a clear caption and point details, and add explanatory prose with append_page_markdown if useful.`
      : `Write content directly to the page "${event.detail.title}" (page ID ${event.detail.pageId}) using muxterm's append_page_markdown tool.`;
    this.draft = this.draft.trim() ? `${this.draft.trim()}\n\n${request}` : request;
    void this.updateComplete.then(() => this.shadowRoot?.querySelector<HTMLTextAreaElement>('.composer-row textarea')?.focus());
  }
  private startDrawerResize(event: PointerEvent) {
    event.preventDefault();
    this.resizingDrawer = true;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
  }
  private moveDrawerResize(event: PointerEvent) {
    if (!this.resizingDrawer) return;
    const { min, max } = this.widthLimits();
    const right = this.shadowRoot?.querySelector<HTMLElement>('.layout')?.getBoundingClientRect().right || window.innerWidth;
    this.drawerWidth = Math.round(Math.max(min, Math.min(max, right - event.clientX)));
  }
  private endDrawerResize() {
    if (!this.resizingDrawer) return;
    this.resizingDrawer = false;
    try { localStorage.setItem(this.drawerKey(), String(this.drawerWidth)); } catch { /* private browsing */ }
  }
  private touchedFiles(): string[] {
    const found = new Set<string>();
    const root = this.chat?.projectPath?.replace(/\/$/, '') || '';
    const add = (candidate: unknown) => {
      if (typeof candidate !== 'string' || !candidate) return;
      const rel = root && candidate.startsWith(root + '/') ? candidate.slice(root.length + 1) : candidate;
      if (!rel.startsWith('/') && !rel.split('/').includes('..') && rel !== '.') found.add(rel);
    };
    for (const block of this.blocks) {
      if (block.kind !== 'tool') continue;
      const raw = block.input;
      if (!raw || typeof raw !== 'object') continue;
      const data = raw as Record<string, unknown>;
      add(data.file_path); add(data.path);
      for (const source of [data.patch, data.code, data.source, data.input]) {
        if (typeof source !== 'string') continue;
        for (const match of source.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) add(match[1]);
      }
    }
    return [...found].slice(-30).reverse();
  }
  private connect() {
    if (!this.isConnected || !this.sessionId || this.activeSession === this.sessionId) return;
    this.persistTranscriptCache();
    this.voice?.stop();
    this.voice = new SDKVoiceSession(this.sessionId, state => { this.voiceState = state; }, levels => this.updateVoiceLevels(levels));
    this.activeSession = this.sessionId;
    const epoch = ++this.historyEpoch;
    this.historyAbort?.abort();
    this.historyAbort = new AbortController();
    this.stream?.close(); this.stream = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.reconnectTimer = undefined; this.cacheTimer = undefined;
    this.streamCursor = 0; this.reconnectFailures = 0; this.reconnectFailed = false;
    this.idleSuspended = false;
    this.resetTranscript();
    this.loadedEvents = []; this.liveEvents = []; this.historyFrom = 0; this.historyTo = 0; this.hasOlder = false; this.loadingOlder = false; this.loadingDetails = false; this.detailsLoaded = false;
    this.fillingRecent = false; this.restoringScroll = false; this.historyUserInteracted = false; this.olderTask = undefined;
    this.rowHeights.clear(); this.visibleStart = 0; this.visibleEnd = 0;
    this.selectedAgent = ''; this.parentScrollTop = 0; this.agentEvents = null; this.agentHistoryError = '';
    this.recoveryPrepared = false;
    this.error = ''; this.settingsPending = false; this.showScrollBottom = false;
    const cached = readTranscriptCache(this.sessionId);
    this.chat = sdkChats.chats.find(c => c.id === this.sessionId) || cached?.chat;
    this.recoveryRequired = this.chat?.state === 'uncertain';
    this.busy = this.chat?.state === 'working';
    if (cached?.blocks.length) {
      this.blocks = cached.blocks;
      this.currentTurn = Math.max(...cached.blocks.map(block => block.turn));
      this.nextBlockKey = Math.max(...cached.blocks.map(block => block.key));
      this.visibleEnd = this.transcriptRows().length;
      void this.updateComplete.then(() => {
        if (epoch !== this.historyEpoch || this.historyUserInteracted) return;
        const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
        if (body) body.scrollTop = body.scrollHeight;
      });
    }
    if (document.hidden) this.idleSuspended = true;
    else {
      void this.loadRecent(this.sessionId, epoch, this.historyAbort.signal);
      void this.loadAgentHistory(this.sessionId, epoch, this.historyAbort.signal);
    }
  }
  private async loadAgentHistory(id: string, epoch: number, signal: AbortSignal) {
    this.agentHistoryError = '';
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}/agents`), { signal, cache:'no-store' });
      if (!response.ok) throw new Error(`Agent history request failed (${response.status})`);
      const saved = await response.json() as SDKEvent[];
      if (epoch !== this.historyEpoch) return;
      this.agentHistoryError = '';
      const seen = new Set<string>();
      this.agentEvents = [...saved, ...this.liveEvents.filter(event => event.type.startsWith('delegate.') || event.type === 'tool.started' || event.type === 'tool.completed')]
        .filter(event => {
          const key = `${event.at}|${event.type}|${event.childSessionId}|${event.toolId}|${event.kind}|${event.text}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    } catch (error) {
      if (epoch === this.historyEpoch && !signal.aborted) this.agentHistoryError = String(error);
    }
  }
  private retryAgentHistory() {
    if (this.historyAbort) void this.loadAgentHistory(this.sessionId, this.historyEpoch, this.historyAbort.signal);
  }
  private persistTranscriptCache = () => {
    if (!this.activeSession) return;
    const pending = new Set(this.pendingInputs.values());
    const blocks = this.blocks.filter(block => (block.kind === 'user' || block.kind === 'assistant') && !pending.has(block.key))
      .slice(-80).map(block => ({ key:block.key, turn:block.turn, kind:block.kind, text:block.text, channel:block.channel, done:block.done, attachments:block.attachments }));
    if (!blocks.length) return;
    const chat = this.chat?.id === this.activeSession ? this.chat : undefined;
    let encoded = JSON.stringify({ blocks, chat });
    while (encoded.length > 400_000 && blocks.length > 1) {
      blocks.shift();
      encoded = JSON.stringify({ blocks, chat });
    }
    if (encoded.length > 400_000) {
      blocks[0].text = `…${blocks[0].text.slice(-200_000)}`;
      encoded = JSON.stringify({ blocks, chat });
    }
    const snapshot = { blocks, chat } as CachedTranscript;
    transcriptCache.set(this.activeSession, snapshot);
    try { sessionStorage.setItem(transcriptCacheKey(this.activeSession), encoded); } catch { /* storage can be unavailable */ }
  };
  private queueTranscriptCache() {
    if (this.cacheTimer) return;
    this.cacheTimer = window.setTimeout(() => { this.cacheTimer = undefined; this.persistTranscriptCache(); }, 150);
  }
  private resetTranscript() {
    this.blocks = []; this.trajectory = []; this.parsers.clear(); this.workExpanded.clear(); this.stepExpanded.clear();
    this.turnStarted.clear(); this.turnFinished.clear(); this.currentTurn = 0; this.now = Date.now();
    this.nextBlockKey = 0; this.turnStart = 0; this.completedInputAnchors.clear(); this.pendingInputs.clear(); this.rowsCache = undefined;
  }
  private async loadRecent(id: string, epoch: number, signal: AbortSignal) {
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}/history?view=messages`), { signal, cache:'no-store' });
      if (!response.ok) throw new Error(`History request failed (${response.status})`);
      const page = await response.json() as HistoryPage;
      if (epoch !== this.historyEpoch) return;
      let from = page.from, hasMore = page.hasMore;
      let events = page.events;
      // Keep the cached transcript visible while sparse recent pages fill in.
      const cachedTurns = new Set(this.blocks.filter(block => block.kind === 'user').map(block => block.turn)).size;
      const targetTurns = Math.min(4, cachedTurns);
      const userTurns = () => events.filter(event => event.type === 'input.accepted' && event.kind !== 'steer').length;
      while (hasMore && userTurns() < targetTurns) {
        const olderResponse = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}/history?before=${from}&view=messages`), { signal, cache:'no-store' });
        if (!olderResponse.ok) throw new Error(`History request failed (${olderResponse.status})`);
        const older = await olderResponse.json() as HistoryPage;
        if (epoch !== this.historyEpoch) return;
        if (older.from >= from) throw new Error('History pages did not advance.');
        from = older.from; hasMore = older.hasMore; events = [...older.events, ...events];
      }
      if (cachedTurns && !events.some(event => event.type === 'input.accepted' || event.type === 'assistant.delta')) {
        throw new Error('The history response contained no displayable messages.');
      }
      this.historyFrom = from; this.historyTo = page.to; this.hasOlder = hasMore;
      this.loadedEvents = events; this.liveEvents = [];
      this.streamCursor = page.to;
      this.reconnectFailures = 0; this.reconnectFailed = false; this.error = '';
      this.replayEvents();
      this.queueTranscriptCache();
      this.busy = this.chat?.state === 'working';
      const rows = this.transcriptRows();
      this.visibleStart = rows.length <= 80 ? 0 : Math.max(0, rows.length - 35); this.visibleEnd = rows.length;
      await this.updateComplete;
      if (epoch !== this.historyEpoch) return;
      const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
      if (body && !this.historyUserInteracted) body.scrollTop = body.scrollHeight;
      // The byte offset precedes any events written during the history fetch.
      this.openStream(id, epoch);
      void this.fillRecentHistory(epoch);
    } catch {
      if (epoch === this.historyEpoch && !signal.aborted) this.scheduleReconnect(epoch, () => void this.loadRecent(id, epoch, signal));
    }
  }
  private openStream(id: string, epoch: number) {
    if (epoch !== this.historyEpoch) return;
    const source = new EventSource(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}/events?after=${this.streamCursor}`));
    this.stream = source;
    this.streamOpenedAt = Date.now();
    source.onopen = () => { if (this.stream === source) this.streamOpenedAt = Date.now(); };
    source.addEventListener('snapshot', e => {
      if (epoch !== this.historyEpoch || this.stream !== source) return;
      try { this.chat = JSON.parse((e as MessageEvent).data) as SDKChat; }
      catch { this.failStream(source, id, epoch); return; }
      if (this.reconnectFailed) { this.reconnectFailed = false; this.error = ''; }
      this.busy = this.chat.state === 'working';
    });
    source.addEventListener('sdk', e => {
      if (epoch !== this.historyEpoch || this.stream !== source) return;
      const message = e as MessageEvent;
      const cursor = Number(message.lastEventId);
      if (!Number.isSafeInteger(cursor) || cursor <= 0) { this.failStream(source, id, epoch); return; }
      if (cursor <= this.streamCursor) return;
      try { this.onEvent(JSON.parse(message.data) as SDKEvent); }
      catch { this.failStream(source, id, epoch); return; }
      this.streamCursor = cursor;
      this.reconnectFailures = 0;
      this.queueTranscriptCache();
    });
    source.onerror = () => this.failStream(source, id, epoch);
  }
  private failStream(source: EventSource, id: string, epoch: number) {
    if (epoch !== this.historyEpoch || this.stream !== source) return;
    source.close(); this.stream = undefined;
    if (Date.now() - this.streamOpenedAt > 10_000) this.reconnectFailures = 0;
    this.scheduleReconnect(epoch, () => this.openStream(id, epoch));
  }
  private scheduleReconnect(epoch: number, retry: () => void) {
    if (epoch !== this.historyEpoch) return;
    if (document.hidden) { this.idleSuspended = true; return; }
    this.reconnectFailures = Math.min(this.reconnectFailures + 1, 8);
    if (this.reconnectFailures >= 7) {
      this.reconnectFailed = true;
      this.error = 'Chat is offline. Reconnecting automatically…';
    }
    const delay = Math.min(8_000, 500 * 2 ** (this.reconnectFailures - 1));
    this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = undefined; retry(); }, delay);
  }
  private retryConnection() {
    this.historyEpoch++;
    this.historyAbort?.abort();
    this.stream?.close(); this.stream = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined; this.reconnectFailures = 0; this.reconnectFailed = false; this.error = '';
    this.historyAbort = new AbortController();
    this.hasOlder = false; this.fillingRecent = false; this.loadingOlder = false; this.loadingDetails = false; this.restoringScroll = false; this.olderTask = undefined;
    void this.loadRecent(this.sessionId, this.historyEpoch, this.historyAbort.signal);
    void this.loadAgentHistory(this.sessionId, this.historyEpoch, this.historyAbort.signal);
  }
  private replayEvents() {
    const busy = this.busy;
    this.resetTranscript();
    this.replaying = true;
    for (const event of this.loadedEvents) this.onEvent(event);
    this.replaying = false;
    this.busy = busy;
  }
  private async fillRecentHistory(epoch: number) {
    if (this.fillingRecent) return;
    this.fillingRecent = true;
    try {
      // A page is bounded by events, not turns. A long streaming answer can
      // consume the whole page and leave no scrollbar to reveal older turns.
      for (let pages = 0; pages < 32 && epoch === this.historyEpoch && this.hasOlder; pages++) {
        const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
        if (!body) break;
        const turns = new Set(this.blocks.filter(block => block.kind === 'user').map(block => block.turn)).size;
        if (turns >= 4 && body.scrollHeight > body.clientHeight + 160) break;
        if (!await this.loadOlder()) break;
        // Let the browser paint each page before reading another one.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    } finally {
      if (epoch === this.historyEpoch) {
        this.fillingRecent = false;
        // ResizeObserver replaces row estimates after the first paint. Keep
        // the newest answer in view until those measurements have settled.
        for (let frame = 0; frame < 3; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          await this.updateComplete;
          if (epoch !== this.historyEpoch || this.historyUserInteracted) break;
          const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
          if (body) body.scrollTop = body.scrollHeight;
        }
      }
    }
  }
  private scrollAnchor(body: HTMLElement) {
    const { top, bottom: viewportBottom } = body.getBoundingClientRect();
    for (const row of body.querySelectorAll<HTMLElement>('[data-row-index]')) {
      const bounds = row.getBoundingClientRect();
      if (bounds.bottom > top && bounds.top < viewportBottom) return { index:Number(row.dataset.rowIndex), bottom:bounds.bottom - top };
    }
    return undefined;
  }
  private restoreScrollAnchor(body: HTMLElement, index: number, bottom: number) {
    const row = body.querySelector<HTMLElement>(`[data-row-index="${index}"]`);
    if (row) body.scrollTop += row.getBoundingClientRect().bottom - body.getBoundingClientRect().top - bottom;
  }
  private loadOlder(): Promise<boolean> {
    if (this.olderTask) return this.olderTask;
    const task = this.fetchOlder();
    this.olderTask = task;
    void task.finally(() => { if (this.olderTask === task) this.olderTask = undefined; });
    return task;
  }
  private async fetchOlder(): Promise<boolean> {
    if (!this.hasOlder || this.loadingOlder || this.loadingDetails || !this.activeSession) return false;
    const epoch = this.historyEpoch;
    const id = this.activeSession;
    const before = this.historyFrom;
    this.loadingOlder = true;
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}/history?before=${before}&view=messages`), { signal: this.historyAbort?.signal });
      if (!response.ok) throw new Error(`Older history request failed (${response.status})`);
      const page = await response.json() as HistoryPage;
      if (epoch !== this.historyEpoch) return false;
      await this.updateComplete;
      if (epoch !== this.historyEpoch) return false;
      this.historyFrom = page.from; this.hasOlder = page.hasMore;
      this.detailsLoaded = false;
      this.loadingOlder = false;
      await this.replayWithAnchor([...page.events, ...this.loadedEvents], epoch, true);
      return true;
    } catch (error) {
      if (epoch === this.historyEpoch && !this.historyAbort?.signal.aborted) this.error = String(error);
      return false;
    } finally {
      if (epoch === this.historyEpoch) { this.loadingOlder = false; this.restoringScroll = false; }
    }
  }
  private async replayWithAnchor(events: SDKEvent[], epoch: number, prepending = false) {
    const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
    const oldRows = this.transcriptRows();
    const anchor = body && this.scrollAnchor(body);
    const oldStart = this.visibleStart, oldEnd = this.visibleEnd;
    const oldHeights = this.rowHeights;
    const expanded = new Set(this.workExpanded);
    const expandedSteps = new Set(this.stepExpanded);
    const oldTurn = this.currentTurn;
    this.loadedEvents = events;
    this.replayEvents();
    const turnShift = prepending ? this.currentTurn - oldTurn : 0;
    this.workExpanded = new Set([...expanded].map(turn => turn + turnShift));
    this.stepExpanded = new Set([...expandedSteps].map(key => {
      const [turn, index] = key.split(':');
      return `${Number(turn) + turnShift}:${index}`;
    }));
    const rows = this.transcriptRows();
    const shift = rows.length - oldRows.length;
    this.rowHeights = new Map();
    for (let i = 0; i < oldRows.length; i++) {
      const height = oldHeights.get(oldRows[i].key);
      if (height !== undefined && rows[i + shift]) this.rowHeights.set(rows[i + shift].key, height);
    }
    this.visibleStart = rows.length <= 80 ? 0 : Math.max(0, oldStart + shift);
    this.visibleEnd = rows.length <= 80 ? rows.length : Math.min(rows.length, oldEnd + shift);
    this.restoringScroll = true;
    try {
      await this.updateComplete;
      if (epoch !== this.historyEpoch) return;
      const current = this.shadowRoot?.querySelector<HTMLElement>('.body');
      if (current && anchor) this.restoreScrollAnchor(current, anchor.index + shift, anchor.bottom);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      await this.updateComplete;
      if (epoch !== this.historyEpoch) return;
      if (current && anchor) this.restoreScrollAnchor(current, anchor.index + shift, anchor.bottom);
      this.updateVisibleRows();
      await this.updateComplete;
      if (epoch === this.historyEpoch && current && anchor) this.restoreScrollAnchor(current, anchor.index + shift, anchor.bottom);
    } finally {
      if (epoch === this.historyEpoch) this.restoringScroll = false;
    }
  }
  private async loadDetails() {
    if (this.detailsLoaded || this.loadingDetails) return;
    const epoch = this.historyEpoch;
    this.loadingDetails = true;
    try {
      await this.olderTask;
      if (epoch !== this.historyEpoch) return;
      const from = this.historyFrom, to = this.historyTo;
      const id = this.activeSession;
      const pages: SDKEvent[][] = [];
      let cursor = to;
      while (cursor > from) {
        const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(id)}/history?before=${cursor}`), { signal:this.historyAbort?.signal });
        if (!response.ok) throw new Error(`Work details request failed (${response.status})`);
        const page = await response.json() as HistoryPage;
        if (epoch !== this.historyEpoch) return;
        if (page.from >= cursor || page.from < from) throw new Error('Work detail pages did not align with loaded history.');
        pages.push(page.events);
        cursor = page.from;
      }
      this.detailsLoaded = true;
      this.loadingDetails = false;
      await this.replayWithAnchor([...pages.reverse().flat(), ...this.liveEvents], epoch);
    } catch (error) {
      if (epoch === this.historyEpoch && !this.historyAbort?.signal.aborted) this.error = String(error);
    } finally {
      if (epoch === this.historyEpoch) this.loadingDetails = false;
    }
  }
  private onEvent(event: SDKEvent) {
    if (!this.replaying) { this.loadedEvents.push(event); this.liveEvents.push(event); }
    if (!this.replaying && this.agentEvents && (event.type.startsWith('delegate.') || event.type === 'tool.started' || event.type === 'tool.completed'))
      this.agentEvents = [...this.agentEvents, event];
    if (['input.accepted', 'assistant.delta', 'thinking.delta', 'tool.started', 'tool.completed', 'delegate.spawned', 'delegate.completed', 'delegate.message', 'delegate.step', 'turn.completed', 'turn.cancelled', 'turn.continued', 'error'].includes(event.type)) {
      if (this.replaying) this.trajectory.push(event);
      else this.trajectory = [...this.trajectory, event];
    }
    // A history replay renders once at the end; cloning every intermediate
    // block array makes a long transcript quadratic before the first paint.
    const blocks = this.replaying ? this.blocks : [...this.blocks];
    const eventTime = Date.parse(event.at || '') || Date.now();
    const markStart = (turn: number) => {
      const previous = this.turnStarted.get(turn);
      if (previous === undefined || eventTime < previous) this.turnStarted.set(turn, eventTime);
    };
    if (event.type === 'voice.input.delta' || event.type === 'voice.output.delta') {
      const kind = event.type === 'voice.input.delta' ? 'user' : 'assistant';
      const last = blocks[blocks.length - 1];
      if (last?.kind === kind && last.channel === 'voice' && !last.done) blocks[blocks.length - 1] = { ...last, text:last.text + (event.text || '') };
      else blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind, channel:'voice', text:event.text || '' });
    }
    else if (event.type === 'input.accepted' && event.source === 'voice') {
      this.busy = true;
      markStart(this.currentTurn);
    }
    else if (event.type === 'input.accepted') {
      this.recoveryRequired = false;
      this.recoveryPrepared = false;
      const pendingKey = event.inputId ? this.pendingInputs.get(event.inputId) : undefined;
      if (event.inputId) this.pendingInputs.delete(event.inputId);
      const pendingIndex = pendingKey === undefined ? -1 : blocks.findIndex(block => block.key === pendingKey);
      if (pendingIndex >= 0) {
        blocks[pendingIndex] = { ...blocks[pendingIndex], text:event.text || blocks[pendingIndex].text, attachments:event.attachments || blocks[pendingIndex].attachments };
      } else
      if (event.kind === 'steer') {
        const last = blocks[blocks.length - 1];
        if (last?.kind === 'assistant') blocks[blocks.length - 1] = { ...last, done:true };
        markStart(this.currentTurn);
        blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'user', text:event.text || '' });
      } else {
        // The harness can stream a fast reply before its send receipt arrives.
        const anchor = event.inputId ? this.completedInputAnchors.get(event.inputId) : undefined;
        const anchoredTurn = anchor === undefined ? undefined : blocks.find(b => b.key === anchor)?.turn;
        let at = anchor === undefined ? (blocks.slice(this.turnStart).some(b => b.channel === 'voice') ? blocks.length : this.turnStart) : blocks.findIndex(b => b.key === anchor);
        if (at < 0) at = this.turnStart;
        while (blocks[at]?.kind === 'user') at++;
        const turn = anchoredTurn ?? blocks[at]?.turn ?? this.currentTurn;
        markStart(turn);
        blocks.splice(at, 0, { key:++this.nextBlockKey, turn, kind:'user', text:event.text || '', attachments:event.attachments || [] });
        if (at < this.turnStart) this.turnStart++;
        if (turn === this.currentTurn) this.busy = true;
      }
      if (pendingIndex < 0 && event.kind !== 'steer' && !blocks.some(block => block.turn === this.currentTurn && block.kind === 'progress'))
        blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'progress', text:'Message received' });
      for (const block of blocks) if (block.turn === this.currentTurn && block.kind === 'progress') block.text = 'Starting…';
      markStart(this.currentTurn);
      if (event.kind === 'steer') this.busy = true;
    }
    else if (event.type === 'assistant.delta') {
      markStart(this.currentTurn);
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'assistant' && last.channel !== 'voice' && !last.done) blocks[blocks.length - 1] = { ...last, text:last.text + (event.text || '') };
      else blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'assistant', channel:'task', text:event.text || '' });
    } else if (event.type === 'assistant.interim') {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'assistant' && last.channel !== 'voice' && !last.done) blocks[blocks.length - 1] = { ...last, kind:'thinking', done:true };
    } else if (event.type === 'thinking.delta') {
      markStart(this.currentTurn);
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'thinking') blocks[blocks.length - 1] = { ...last, text:last.text + (event.text || '') };
      else blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'thinking', text:event.text || '' });
    } else if (event.type === 'tool.started') {
      markStart(this.currentTurn);
      // Text before a tool call was an interim progress note, not the final answer.
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'assistant' && last.channel !== 'voice' && !last.done) blocks[blocks.length - 1] = { ...last, kind:'thinking', done:true };
      const existing = blocks.findIndex(b => b.kind === 'tool' && b.id === event.toolId && !b.done);
      if (existing >= 0) blocks[existing] = { ...blocks[existing], name:event.name || blocks[existing].name, input:event.raw ?? blocks[existing].input, summary:event.summary || blocks[existing].summary };
      else blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'tool', text:'Running', name:event.name || 'Tool', id:event.toolId, input:event.raw, summary:event.summary });
    }
    else if (event.type === 'tool.completed') {
      markStart(this.currentTurn);
      let index = -1; for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'tool' && blocks[i].id === event.toolId && !blocks[i].done) { index = i; break; }
      if (index >= 0) blocks[index] = { ...blocks[index], done:true, text:event.failed ? 'Failed' : 'Completed', failed:event.failed, summary:event.summary || blocks[index].summary,
        output:event.raw };
      else blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'tool', text:event.failed ? 'Failed' : 'Completed', name:event.name || 'Tool', id:event.toolId, done:true, failed:event.failed, summary:event.summary,
        output:event.raw });
    } else if (event.type === 'delegate.spawned' && event.childSessionId) {
      markStart(this.currentTurn);
      if (!blocks.some(block => block.kind === 'delegate' && block.id === event.childSessionId))
        blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'delegate', text:'Running', name:event.agent || 'Agent', id:event.childSessionId });
    } else if (event.type === 'delegate.completed' && event.childSessionId) {
      const index = blocks.findIndex(block => block.kind === 'delegate' && block.id === event.childSessionId);
      if (index >= 0) blocks[index] = { ...blocks[index], text:event.failed ? 'Failed' : 'Completed', done:true, failed:event.failed };
      else blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'delegate', text:event.failed ? 'Failed' : 'Completed', name:event.agent || 'Agent', id:event.childSessionId, done:true, failed:event.failed });
    } else if (event.type === 'tool.result') {
      let index = -1; for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'tool' && blocks[i].id === event.toolId) { index = i; break; }
      if (index >= 0) blocks[index] = { ...blocks[index], output:event.raw, done:true };
    } else if (event.type === 'turn.continued') {
      for (const b of blocks) if (b.kind === 'assistant') b.done = true;
    } else if (event.type === 'turn.completed') {
      this.busy = false;
      this.turnFinished.set(this.currentTurn, eventTime);
      for (const b of blocks) if (b.kind === 'assistant') b.done = true;
      const anchor = blocks[this.turnStart]?.key;
      if (anchor !== undefined) for (const id of event.inputIds || []) this.completedInputAnchors.set(id, anchor);
      this.turnStart = blocks.length;
      this.currentTurn++;
      if (!this.replaying) void sdkChats.refresh();
    }
    else if (event.type === 'turn.cancelled') {
      this.busy = false;
      this.turnFinished.set(this.currentTurn, eventTime);
      this.stopping = false;
      for (const b of blocks) if (b.kind === 'assistant') b.done = true;
      blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'status', text:'Stopped by you · partial output kept' });
      this.turnStart = blocks.length;
      this.currentTurn++;
      if (!this.replaying) void sdkChats.refresh();
    }
    else if (event.type === 'goal.progress') {
      if (this.chat) this.chat = { ...this.chat, goalState: event.goalState, goalReason: event.goalReason, goalSummary: event.goalSummary };
      if (event.goalState !== 'continuing') blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'status', text:`Goal ${event.goalState || 'updated'}: ${event.goalSummary || event.goalReason || ''}` });
    }
    else if (event.type === 'task.cancel.requested') {
      blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'status', text:'Task cancellation requested.' });
    }
    else if (event.type === 'voice.session.error') {
      blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'status', text:event.message || 'Voice connection lost.' });
      if (!this.replaying && event.generationId && this.voice?.providerSessionId === event.generationId) this.voice.stop();
    }
    else if (event.type === 'session.renamed') { if (!this.replaying) void sdkChats.refresh(); }
    else if (event.type === 'error' || event.type === 'session.uncertain') { this.turnFinished.set(this.currentTurn, eventTime); blocks.push({ key:++this.nextBlockKey, turn:this.currentTurn, kind:'error', text:event.message || 'Session error' }); this.turnStart = blocks.length; this.currentTurn++; this.busy = false; if (event.type === 'session.uncertain') this.recoveryRequired = true; if (!this.replaying) void sdkChats.refresh(); }
    this.blocks = blocks;
    if (this.replaying) return;
    const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
    const follow = !body || body.scrollHeight - body.scrollTop - body.clientHeight < 100;
    if (follow) { const count = this.transcriptRows().length; this.visibleStart = count <= 80 ? 0 : Math.max(0, count - 35); this.visibleEnd = count; }
    void this.updateComplete.then(() => {
      if (follow) {
        const b = this.shadowRoot?.querySelector<HTMLElement>('.body');
        if (b) b.scrollTop = b.scrollHeight;
      }
      this.updateScrollBottomVisibility();
    });
  }
  private markdown(block: Block, index: number) {
    let parser = this.parsers.get(index);
    if (!parser) { parser = new MarkdownStream(); this.parsers.set(index, parser); }
    return renderSegments(parser.update(block.text, !block.done), chatMarkdownPolicy);
  }
  private userBubble(block: Block) {
    return html`<div class="bubble">${block.text}${block.attachments?.map(attachment => attachment.kind === 'image'
      ? html`<img src=${apiPath(`/api/sdk-chat-attachments/${encodeURIComponent(attachment.id)}`)} alt=${attachment.name} loading="lazy">`
      : html`<a href=${apiPath(`/api/sdk-chat-attachments/${encodeURIComponent(attachment.id)}`)} target="_blank" rel="noopener">${attachment.name}</a>`)}</div>`;
  }
  private hasFiles(event: DragEvent) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }
  private onDragEnter(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); this.dragDepth++; this.dropActive = true; }
  private onDragOver(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; this.dropActive = true; }
  private onDragLeave(event: DragEvent) { if (!this.hasFiles(event)) return; event.preventDefault(); this.dragDepth = Math.max(0, this.dragDepth - 1); if (!this.dragDepth) this.dropActive = false; }
  private onDrop(event: DragEvent) {
    if (!this.hasFiles(event)) return;
    event.preventDefault(); event.stopPropagation(); this.resetDrop();
    this.addFiles(Array.from(event.dataTransfer?.files || []));
  }
  private onPick(event: Event) {
    const input = event.target as HTMLInputElement;
    this.addFiles(Array.from(input.files || [])); input.value = '';
  }
  private onPaste(event: ClipboardEvent) {
    if (this.voiceState !== 'idle') return;
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
      // The upload response is authoritative about image versus generic file.
      const item: Attachment = { localId: crypto.randomUUID(), file, preview:file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined, uploading: true };
      this.attachments = [...this.attachments, item];
      void this.upload(item);
    }
  }
  private async upload(item: Attachment) {
    const form = new FormData(); form.append('file', item.file);
    try {
      const response = await fetch(apiPath('/api/sdk-chat-attachments'), {
        method: 'POST', headers: { 'X-Muxterm-Chat-Attachment': '1' }, body: form,
      });
      const body = await response.text();
      let payload: { id?: string; kind?: string; reason?: string } = {};
      try { payload = JSON.parse(body) as typeof payload; } catch { /* Preserve non-JSON server errors below. */ }
      if (!response.ok) throw new Error(payload.reason || body.trim() || `Upload failed (${response.status})`);
      if (!payload.id || !payload.kind) throw new Error('Upload response lacked attachment details');
      if (!this.attachments.some(a => a.localId === item.localId)) return;
      if (payload.kind !== 'image' && item.preview) URL.revokeObjectURL(item.preview);
      this.attachments = this.attachments.map(a => a.localId === item.localId
        ? { ...a, id: payload.id, kind: payload.kind, preview:payload.kind === 'image' ? item.preview : undefined, uploading: false } : a);
    } catch (error) {
      if (!this.attachments.some(a => a.localId === item.localId)) return;
      this.attachments = this.attachments.map(a => a.localId === item.localId
        ? { ...a, uploading: false, error: error instanceof Error ? error.message : String(error) } : a);
    }
  }
  private removeAttachment(localId: string) {
    const item = this.attachments.find(a => a.localId === localId);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    this.attachments = this.attachments.filter(a => a.localId !== localId);
  }
  private detail(value: unknown): string {
    if (value == null) return 'No detail was supplied by the harness.';
    let rendered: string;
    if (typeof value === 'string') rendered = value || '(empty)';
    else if (Array.isArray(value)) rendered = value.map(item => item && typeof item === 'object' && 'text' in item
      ? String((item as { text: unknown }).text) : JSON.stringify(item, null, 2)).join('\n');
    else rendered = JSON.stringify(value, null, 2) || String(value);
    const limit = 12000;
    return rendered.length > limit ? `${rendered.slice(0, limit)}\n… truncated after ${limit.toLocaleString()} characters (${rendered.length.toLocaleString()} total)` : rendered;
  }
  private toolInput(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    const raw = value as Record<string, unknown>;
    if (raw.type === 'tool_use') return raw.input;
    if (raw.type === 'commandExecution') return { command:raw.command, cwd:raw.cwd };
    if (raw.type === 'mcpToolCall') return { server:raw.server, tool:raw.tool, arguments:raw.arguments };
    return value;
  }
  private toolOutput(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    const raw = value as Record<string, unknown>;
    if (raw.type === 'tool_result') return raw.content;
    if (raw.type === 'commandExecution') return `Exit code: ${raw.exitCode ?? 'unknown'} · ${raw.status || 'unknown'}\n\n${raw.aggregatedOutput || ''}`;
    if (raw.type === 'mcpToolCall') return { result:raw.result, error:raw.error, status:raw.status };
    if (typeof raw.output === 'string') return `Exit code: ${raw.exitCode ?? 'unknown'} · ${raw.status || 'unknown'}\n\n${raw.output}`;
    if (raw.output && typeof raw.output === 'object') {
      const output = raw.output as Record<string, unknown>;
      if (typeof output.content === 'string') return output.content;
      if ('stdout' in output || 'stderr' in output) return `Exit code: ${output.returncode ?? 'unknown'}\n${output.stderr ? `stderr:\n${output.stderr}\n` : ''}\n${output.stdout || ''}`;
    }
    return value;
  }
  private toolFailed(block: Block): boolean {
    if (block.failed) return true;
    if (!block.done || !block.output || typeof block.output !== 'object') return false;
    const result = block.output as Record<string, unknown>;
    if (result.status === 'failed' || result.is_error === true || result.isError === true || result.error) return true;
    if (typeof result.exitCode === 'number' && result.exitCode !== 0) return true;
    const output = result.output;
    return !!output && typeof output === 'object' && typeof (output as Record<string, unknown>).returncode === 'number'
      && (output as Record<string, unknown>).returncode !== 0;
  }
  private agents(): AgentView[] {
    const events = this.agentEvents ?? this.trajectory;
    const delegates = events.filter(event => event.type === 'delegate.spawned');
    const toolBlocks = this.agentEvents ? (() => {
      const ids = new Set(delegates.map(event => event.toolId).filter(Boolean));
      const byTool = new Map<string, Block>();
      for (const event of events) {
        if (!event.toolId || !ids.has(event.toolId) || (event.type !== 'tool.started' && event.type !== 'tool.completed')) continue;
        const block: Block = byTool.get(event.toolId) || { key:byTool.size, turn:0, kind:'tool', text:'Running', id:event.toolId };
        if (event.type === 'tool.started') { block.name = event.name; block.input = event.raw; }
        else { block.done = true; block.failed = event.failed; block.output = event.raw; }
        byTool.set(event.toolId, block);
      }
      return [...byTool.values()];
    })() : this.blocks.filter(block => block.kind === 'tool');
    const byId = new Map<string, AgentView>();
    const add = (id: string, name: string, parentId: string) => {
      let agent = byId.get(id);
      if (!agent) { agent = { id, name, parentId, status:'Running', progress:'', legs:[], steps:[] }; byId.set(id, agent); }
      if (name && name !== 'Agent') agent.name = name;
      return agent;
    };
    for (const block of toolBlocks.filter(block => /^(delegate|Agent|Task|subAgentActivity)$/i.test(block.name || ''))) {
      const input = this.toolInput(block.input);
      const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      if (block.name === 'subAgentActivity' && fields.kind !== 'started') continue;
      const spawned = delegates.find(event => event.toolId === block.id);
      const output = this.toolOutput(block.output);
      const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
      const body = result.output && typeof result.output === 'object' ? result.output as Record<string, unknown> : result;
      const id = spawned?.childSessionId || (typeof body.session_id === 'string' ? body.session_id : '') || (typeof fields.agentThreadId === 'string' ? fields.agentThreadId : '') || block.id || String(block.key);
      const name = (typeof fields.agent === 'string' ? fields.agent : '') || (typeof fields.subagent_type === 'string' ? fields.subagent_type : '') || spawned?.agent || (typeof fields.agentPath === 'string' ? fields.agentPath : '') || block.name || 'Agent';
      const task = fields.instruction || fields.prompt || fields.description || fields.task || fields.message;
      const reply = body.response || body.output || output;
      const agent = add(id, name, spawned?.parentSessionId || this.sessionId);
      const status = block.done ? this.toolFailed(block) ? 'Failed' : 'Completed' : 'Running';
      agent.legs.push({ task:typeof task === 'string' ? task : '', reply:block.done && block.name !== 'subAgentActivity' ? this.detail(reply) : '', status });
      agent.status = status;
    }
    for (const event of delegates) if (event.childSessionId) {
      const agent = add(event.childSessionId, event.agent || 'Agent', event.parentSessionId || this.sessionId);
      const startedAt = Date.parse(event.at || '');
      if (Number.isFinite(startedAt) && (agent.startedAt === undefined || startedAt < agent.startedAt)) agent.startedAt = startedAt;
    }
    for (const event of events) if (event.childSessionId) {
      const agent = byId.get(event.childSessionId);
      if (!agent) continue;
      if (event.type === 'delegate.message') agent.progress = event.complete ? event.text || '' : agent.progress + (event.text || '');
      if (event.type === 'delegate.completed') {
        agent.status = event.failed ? 'Failed' : 'Completed';
        const finishedAt = Date.parse(event.at || '');
        if (Number.isFinite(finishedAt)) agent.finishedAt = finishedAt;
      }
      if (event.type === 'delegate.step') {
        const id = event.toolId || `${agent.steps.length}`;
        const step = agent.steps.find(item => item.id === id);
        if (step) { step.status = event.kind === 'completed' ? 'Completed' : 'Running'; step.detail = event.raw ?? step.detail; }
        else agent.steps.push({ id, name:event.name || 'Work', status:event.kind === 'completed' ? 'Completed' : 'Running', detail:event.raw });
      }
    }
    return [...byId.values()];
  }
  private openAgent(id: string) {
    if (!this.selectedAgent) this.parentScrollTop = this.shadowRoot?.querySelector<HTMLElement>('.body')?.scrollTop || 0;
    this.selectedAgent = id;
    this.agentNotice = '';
    if (!this.detailsLoaded) void this.loadDetails();
    void this.updateComplete.then(() => { const body = this.shadowRoot?.querySelector<HTMLElement>('.body'); if (body) body.scrollTop = 0; });
  }
  private returnToParent() {
    this.selectedAgent = '';
    this.agentNotice = '';
    void this.updateComplete.then(() => {
      const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
      if (body) { body.scrollTop = this.parentScrollTop; this.updateVisibleRows(); }
    });
  }
  private agentBreadcrumbs(agents: AgentView[]) {
    const byId = new Map(agents.map(agent => [agent.id, agent]));
    const chain: AgentView[] = [];
    let current = byId.get(this.selectedAgent);
    while (current && chain.length < 8) {
      chain.unshift(current);
      current = byId.get(current.parentId);
    }
    return html`<nav class="breadcrumbs" aria-label="Agent lineage"><button @click=${this.returnToParent}>${this.chat?.title || 'Root session'}</button>${chain.map(agent => html`<span>›</span><strong>${agent.name}</strong>`)}</nav>`;
  }
  private agentCard(block: Block, agents: AgentView[]) {
    const agent = agents.find(item => item.id === block.id);
    const name = agent?.name || block.name || 'Agent';
    const status = agent?.status || block.text;
    const duration = this.agentDuration(agent);
    const task = agent?.legs[0]?.task;
    const preview = task && task !== 'undefined' ? task : agent?.progress || 'View delegated work';
    return html`<button class="delegate-card" aria-label=${`View ${name} work, ${status.toLowerCase()}${duration ? `, ${duration}` : ''}`} @click=${() => this.openAgent(block.id || '')}>
      <span class="delegate-icon" aria-hidden="true">${icon(Bot, { size:16 })}</span>
      <span class="delegate-copy"><span class="delegate-name">${name}</span><span class="delegate-task" title=${preview}>${preview}</span></span>
      <span class="delegate-meta"><span class="delegate-status-dot ${status.toLowerCase()}" title=${status} aria-hidden="true"></span>${duration ? html`<span>${duration}</span>` : nothing}<span class="delegate-chevron" aria-hidden="true">${icon(ChevronRight, { size:15 })}</span></span>
    </button>`;
  }
  private agentDuration(agent?: AgentView) {
    if (agent?.startedAt === undefined) return '';
    const finishedAt = agent.finishedAt ?? (agent.status === 'Running' ? this.now : undefined);
    if (finishedAt === undefined) return '';
    const seconds = Math.max(1, Math.round((finishedAt - agent.startedAt) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  private agentStepDetail(step: AgentStep) {
    const item = step.detail && typeof step.detail === 'object' ? step.detail as Record<string, unknown> : null;
    if (item?.type === 'commandExecution') {
      const actions = Array.isArray(item.commandActions) ? item.commandActions as Record<string, unknown>[] : [];
      const command = typeof actions[0]?.command === 'string' ? actions[0].command : item.command;
      const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.trimEnd() : '';
      const exit = typeof item.exitCode === 'number' && item.exitCode !== 0 ? `\nExit code: ${item.exitCode}` : '';
      return `${typeof command === 'string' ? `$ ${command}` : ''}${output ? `\n${output}` : ''}${exit}`.trim();
    }
    return this.detail(step.detail);
  }
  private agentWork(agent: AgentView | undefined) {
    if (!agent) return html`<div class="block">Agent unavailable in this session.</div>`;
    const task = agent.legs[0]?.task;
    const reply = agent.progress || agent.legs.find(leg => leg.reply && leg.reply !== 'undefined')?.reply;
    return html`<div class="agent-chat">
      <div class="speaker">${agent.name} · ${agent.status}</div>
      ${task && task !== 'undefined' ? html`<div class="instruction">${task}</div>` : nothing}
      ${agent.steps.length ? html`<div class="speaker">Recorded work</div>${agent.steps.map(step => html`<div class="agent-step"><strong>${step.name} · ${step.status}</strong>${step.detail !== undefined ? html`<pre>${this.agentStepDetail(step)}</pre>` : nothing}</div>`)}` : html`<div class="agent-step">${this.agentHistoryError ? 'Saved work could not be loaded.' : this.agentEvents ? 'No individual steps were reported by this harness.' : 'Loading recorded work…'}</div>`}
      <div class="speaker">Result</div><div class="reply">${reply || (agent.status === 'Running' || !this.agentEvents || this.busy ? 'Waiting for the delegated agent’s result…' : 'No result text was reported.')}</div>
    </div>`;
  }
  private async steerAgent() {
    if (this.voiceState !== 'idle') return;
    const agent = this.agents().find(item => item.id === this.selectedAgent);
    const message = this.agentDraft.trim();
    if (!agent || !message) return;
    const content = `Please steer delegated agent ${agent.name} (${agent.id}) with this instruction: ${message}`;
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}`), { method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ kind:this.busy ? 'steer' : 'user', source:'browser', id:crypto.randomUUID(), content }) });
      if (!response.ok) throw new Error(await response.text());
      this.agentDraft = '';
      this.agentNotice = 'Steering request sent to the root session.';
    } catch (error) { this.agentNotice = String(error); }
  }
  private toolKind(block: { name?: string }): ToolKind {
    const name = (block.name || '').toLowerCase();
    if (/web|browse|fetch_url/.test(name)) return 'web';
    if (/bash|shell|command|exec|terminal/.test(name)) return 'shell';
    if (/read|view_file|list_dir|list_files/.test(name)) return 'read';
    if (/grep|search|glob|find/.test(name)) return 'search';
    if (/write|edit|patch/.test(name)) return 'edit';
    if (/agent|delegate|task/.test(name)) return 'agent';
    return 'other';
  }
  private toolIcon(kind: ToolKind): IconNode {
    switch (kind) {
      case 'shell': return Terminal;
      case 'read': return BookOpen;
      case 'search': return Search;
      case 'web': return Globe;
      case 'edit': return FilePenLine;
      case 'agent': return Bot;
      default: return Wrench;
    }
  }
  private toolFields(block: Block): Record<string, unknown> {
    const input = this.toolInput(block.input);
    return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  }
  private toolField(fields: Record<string, unknown>, ...names: string[]): string {
    for (const name of names) if (typeof fields[name] === 'string' && fields[name]) return fields[name] as string;
    return '';
  }
  private toolLine(block: Block) {
    const kind = this.toolKind(block);
    const fields = this.toolFields(block);
    const path = this.toolField(fields, 'file_path', 'path', 'filename', 'uri');
    const file = path.split('/').pop() || path;
    const command = this.toolField(fields, 'command', 'cmd');
    const query = this.toolField(fields, 'query', 'q', 'pattern', 'url');
    const failed = this.toolFailed(block);
    if (kind === 'shell') return `${block.done ? failed ? 'Failed' : 'Ran' : 'Running'} ${command || 'a command'}`;
    if (kind === 'read') return `${block.done ? 'Read' : 'Reading'} ${file || 'a file'}`;
    if (kind === 'search') return `${block.done ? 'Searched' : 'Searching'} for ${query || 'matches'}${file ? ` in ${file}` : ''}`;
    if (kind === 'web') return `${block.done ? 'Searched the web' : 'Searching the web'}${query ? ` for ${query}` : ''}`;
    if (kind === 'edit') return `${block.done ? 'Edited' : 'Editing'} ${file || 'a file'}`;
    if (kind === 'agent') return `${block.done ? 'Delegated' : 'Delegating'} ${this.toolField(fields, 'description', 'task') || 'an agent'}`;
    return `${block.name || 'Tool'}${file ? ` ${file}` : query ? ` ${query}` : ''}`;
  }
  private activityLineForTools(tools: { name?: string }[]) {
    const counts = new Map<ToolKind, number>();
    for (const tool of tools) {
      const kind = this.toolKind(tool);
      counts.set(kind, (counts.get(kind) || 0) + 1);
    }
    return [...counts].map(([kind, count]) => {
      if (kind === 'shell') return count === 1 ? 'ran a command' : `ran ${count} commands`;
      if (kind === 'read') return count === 1 ? 'read a file' : `read ${count} files`;
      if (kind === 'search') return count === 1 ? 'searched files' : `searched files ${count} times`;
      if (kind === 'web') return count === 1 ? 'searched the web' : `searched the web ${count} times`;
      if (kind === 'edit') return count === 1 ? 'edited a file' : `edited ${count} files`;
      if (kind === 'agent') return count === 1 ? 'delegated an agent' : `delegated ${count} agents`;
      return count === 1 ? 'used a tool' : `used ${count} tools`;
    }).join(', ').replace(/^./, first => first.toUpperCase());
  }
  private thinkingEntry(block: Block, key: string) {
    const open = this.stepExpanded.has(key);
    const preview = block.text.trim().replace(/\s+/g, ' ') || 'Thinking…';
    return html`<details class="thinking-entry" aria-label="Thinking detail" ?open=${open}><summary @click=${(event: MouseEvent) => this.toggleStepDisclosure(key, event)}><span class="work-icon">${icon(Brain, { size: 14 })}</span><span class="work-line" title=${preview}>${preview}</span><span class="work-chevron">${icon(ChevronDown, { size: 13 })}</span></summary>${open ? html`<div class="detail"><pre>${block.text}</pre></div>` : nothing}</details>`;
  }
  private toolEntry(block: Block, key: string) {
    const kind = this.toolKind(block);
    const label = this.toolLine(block);
    const open = this.stepExpanded.has(key);
    const input = this.toolInput(block.input);
    const fields = this.toolFields(block);
    const output = block.done ? this.detail(this.toolOutput(block.output)) : 'Running…';
    const heading = kind === 'shell' ? 'Shell' : kind === 'read' ? 'Read file' : kind === 'search' ? 'Search' : kind === 'web' ? 'Web search' : kind === 'edit' ? 'File change' : kind === 'agent' ? 'Agent' : block.name || 'Tool';
    const inputLabel = kind === 'shell' ? 'Command' : kind === 'read' || kind === 'edit' ? 'File / input' : kind === 'search' || kind === 'web' ? 'Query / input' : 'Input';
    const outputLabel = kind === 'shell' ? 'Output' : kind === 'read' ? 'Contents' : kind === 'search' ? 'Matches' : kind === 'web' ? 'Results' : kind === 'agent' ? 'Result' : 'Output';
    const command = this.toolField(fields, 'command', 'cmd');
    const inputText = kind === 'shell' && command ? `$ ${command}` : this.detail(input);
    return html`<details class="tool-entry ${this.toolFailed(block) ? 'failed' : ''}" aria-label=${`${block.name || 'Tool'} detail`} ?open=${open}><summary @click=${(event: MouseEvent) => this.toggleStepDisclosure(key, event)}><span class="work-icon">${icon(this.toolIcon(kind), { size: 14 })}</span><span class="work-line" title=${label}>${label}</span><span class="work-chevron">${icon(ChevronDown, { size: 13 })}</span></summary>${open ? html`<div class="detail"><div class="tool-detail-title">${heading}</div><div class="detail-label">${inputLabel}</div><pre>${inputText}</pre><div class="detail-label">${outputLabel}</div><pre>${output}</pre></div>` : nothing}</details>`;
  }
  private workTimeline(turn: number, items: Block[]) {
    // Raw session events arrive in order. Keep each thinking passage at its
    // original position and collapse only the adjacent tool calls after it.
    const steps: ReturnType<typeof html>[] = [];
    let run: Block[] = [];
    let group = 0;
    const flush = () => {
      if (!run.length) return;
      const tools = run;
      const key = `${turn}:tools-${group++}`;
      const open = this.stepExpanded.has(key);
      steps.push(html`<details class="tool-activity" ?open=${open}><summary @click=${(event: MouseEvent) => this.toggleStepDisclosure(key, event)}><span class="work-icon">${icon(this.toolIcon(this.toolKind(tools[0])), { size: 14 })}</span><span class="work-line">${this.activityLineForTools(tools)}</span><span class="work-chevron">${icon(ChevronDown, { size: 13 })}</span></summary>${open ? html`<div class="tool-activity-items">${tools.map(item => this.toolEntry(item, `${turn}:tool-${item.key}`))}</div>` : nothing}</details>`);
      run = [];
    };
    for (const item of items) {
      if (item.kind === 'tool') run.push(item);
      else {
        flush();
        if (item.kind === 'thinking') steps.push(this.thinkingEntry(item, `${turn}:thinking-${item.key}`));
      }
    }
    flush();
    if (steps.length) return html`${steps}`;
    // Lightweight message history intentionally omits raw thought and tool
    // payloads. Do not display its flattened activity summary as a timeline.
    if (this.loadingDetails || !this.detailsLoaded) return html`<div class="work-item">Loading work details…</div>`;
    if (this.turnFinished.get(turn) === undefined) return html`<div class="work-item">Waiting for activity…</div>`;
    return html`<div class="work-item">No work details were reported.</div>`;
  }
  private workedLabel(turn: number) {
    const started = this.turnStarted.get(turn);
    const finished = this.turnFinished.get(turn);
    if (started === undefined) return finished === undefined ? 'Working…' : 'Worked';
    const seconds = Math.max(1, Math.round(((finished ?? this.now) - started) / 1000));
    const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${finished === undefined ? 'Working' : 'Worked'} for ${duration}`;
  }
  private transcriptRows(): TranscriptRow[] {
    if (this.rowsCache?.blocks === this.blocks) return this.rowsCache.rows;
    const work = new Map<number, Block[]>();
    for (const block of this.blocks) if (block.kind === 'thinking' || block.kind === 'tool' || block.kind === 'progress') {
      const items = work.get(block.turn) || [];
      items.push(block);
      work.set(block.turn, items);
    }
    const shown = new Set<number>();
    const rows: TranscriptRow[] = [];
    for (const block of this.blocks) {
      if (block.kind === 'thinking' || block.kind === 'tool' || block.kind === 'progress') {
        if (shown.has(block.turn)) continue;
        shown.add(block.turn);
        rows.push({ key:`work-${block.turn}`, block, work:work.get(block.turn) });
      } else {
        rows.push({ key:`block-${block.key}`, block });
      }
    }
    this.rowsCache = { blocks:this.blocks, rows };
    return rows;
  }
  private rowHeight(row: TranscriptRow) { return this.rowHeights.get(row.key) || (row.work ? 50 : row.block.kind === 'user' ? 75 : 118); }
  private updateVisibleRows() {
    const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
    if (!body) return;
    const rows = this.transcriptRows();
    if (rows.length <= 80) {
      if (this.visibleStart !== 0) this.visibleStart = 0;
      if (this.visibleEnd !== rows.length) this.visibleEnd = rows.length;
      return;
    }
    const top = Math.max(0, body.scrollTop - 700);
    const bottom = body.scrollTop + body.clientHeight + 700;
    let offset = 0, start = 0;
    while (start < rows.length && offset + this.rowHeight(rows[start]) < top) offset += this.rowHeight(rows[start++]);
    let end = start;
    while (end < rows.length && offset < bottom) offset += this.rowHeight(rows[end++]);
    if (start !== this.visibleStart) this.visibleStart = start;
    if (end !== this.visibleEnd) this.visibleEnd = end;
  }
  private onBodyScroll() {
    // Prepending changes spacer heights before the anchor is restored. Keep
    // its row mounted until the restoration finishes.
    if (!this.restoringScroll) this.updateVisibleRows();
    if (!this.restoringScroll) this.updateScrollBottomVisibility();
    const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
    if (!this.restoringScroll && !this.fillingRecent && body && body.scrollHeight > body.clientHeight && body.scrollTop < 450 && this.hasOlder) void this.loadOlder();
  }
  private updateScrollBottomVisibility() {
    const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
    this.showScrollBottom = !!body && body.scrollHeight - body.scrollTop - body.clientHeight > 100;
  }
  private async scrollToBottom() {
    const session = this.activeSession;
    if (!this.selectedAgent) {
      const count = this.transcriptRows().length;
      this.visibleStart = count <= 80 ? 0 : Math.max(0, count - 35);
      this.visibleEnd = count;
    }
    await this.updateComplete;
    if (session !== this.activeSession) return;
    const body = this.shadowRoot?.querySelector<HTMLElement>('.body');
    if (body) body.scrollTop = body.scrollHeight;
    this.updateScrollBottomVisibility();
  }
  private transcript(agents: AgentView[]) {
    const rows = this.transcriptRows();
    const start = Math.min(this.visibleStart, rows.length);
    const end = Math.min(Math.max(this.visibleEnd, start), rows.length);
    let before = 0, after = 0;
    for (let i = 0; i < start; i++) before += this.rowHeight(rows[i]);
    for (let i = end; i < rows.length; i++) after += this.rowHeight(rows[i]);
    return html`<div class="virtual-spacer" style=${`height:${before}px`}></div>${rows.slice(start, end).map((row, offset) => {
      const block = row.block;
      return row.work ? html`<div class="block work" data-row-key=${row.key} data-row-index=${start + offset}><details class="work-disclosure" ?open=${this.workExpanded.has(block.turn)}><summary @click=${(event: MouseEvent) => this.toggleWorkDisclosure(block.turn, event)}>${this.turnFinished.get(block.turn) === undefined ? html`<span class="pulse" aria-hidden="true"></span>` : nothing}<span class="activity-label">${this.turnFinished.get(block.turn) === undefined && row.work.length === 1 && row.work[0].kind === 'progress' && row.work[0].text === 'Message received' ? 'Message received' : this.workedLabel(block.turn)}</span>${icon(ChevronDown, { size: 14 })}</summary>${this.workExpanded.has(block.turn) ? html`<div class="work-items">${this.workTimeline(block.turn, row.work)}</div>` : nothing}</details></div>`
        : html`<div class="block ${block.kind}" data-row-key=${row.key} data-row-index=${start + offset}>${block.kind === 'user' ? this.userBubble(block) : block.kind === 'assistant' ? block.channel === 'voice' ? html`<div class="speaker">Voice</div><div class="text voice-text">${block.text}</div>` : html`<div class="text">${this.markdown(block, block.key)}</div>` : block.kind === 'delegate' ? this.agentCard(block, agents) : html`<div class="${block.kind}">${block.text}</div>`}</div>`;
    })}<div class="virtual-spacer" style=${`height:${after}px`}></div>`;
  }
  private toggleWorkDisclosure(turn: number, event: MouseEvent) {
    event.preventDefault();
    if (this.workExpanded.has(turn)) this.workExpanded.delete(turn);
    else {
      this.workExpanded.add(turn);
      if (!this.detailsLoaded) void this.loadDetails();
    }
    this.requestUpdate();
  }
  private toggleStepDisclosure(key: string, event: MouseEvent) {
    event.preventDefault();
    if (this.stepExpanded.has(key)) this.stepExpanded.delete(key);
    else this.stepExpanded.add(key);
    this.requestUpdate();
  }
  private async send() {
    const content = this.draft.trim();
    if (this.voiceState !== 'idle' || (!content && !this.attachments.length) || this.stopping || this.settingsPending || this.attachments.some(a => a.uploading || a.error) || (this.busy && (this.attachments.length > 0 || this.isACPChat()))) return;
    const kind = this.busy ? 'steer' : 'user';
    const sent = this.attachments;
    const id = crypto.randomUUID();
    const wasBusy = this.busy;
    const key = ++this.nextBlockKey;
    this.pendingInputs.set(id, key);
    this.blocks = [...this.blocks, { key, turn:this.currentTurn, kind:'user', text:content, attachments:sent.filter(item => item.id).map(item => ({ id:item.id!, name:item.file.name, kind:item.kind || '' })) },
      ...(!wasBusy ? [{ key:++this.nextBlockKey, turn:this.currentTurn, kind:'progress' as const, text:'Message received' }] : [])];
    if (!wasBusy) { this.busy = true; this.turnStarted.set(this.currentTurn, Date.now()); }
    this.draft = '';
    try {
      await this.scrollToBottom();
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}`), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ kind, source:'browser', id, content, attachments: sent.map(a => a.id) }) });
      if (!response.ok) throw new Error(await response.text());
      for (const item of sent) if (item.preview) URL.revokeObjectURL(item.preview);
      this.attachments = this.attachments.filter(a => !sent.includes(a));
      this.error = '';
    } catch (error) {
      this.error = String(error); this.draft = content;
      this.pendingInputs.delete(id);
      this.blocks = this.blocks.filter(block => block.key !== key && !(block.kind === 'progress' && block.turn === this.currentTurn && !wasBusy));
      if (!wasBusy) { this.busy = false; this.turnStarted.delete(this.currentTurn); }
    }
  }
  private prepareRecovery() {
    if (this.selectedAgent) this.returnToParent();
    if (!this.recoveryPrepared) {
      const lastRequest = [...this.blocks].reverse().find(block => block.kind === 'user' && block.turn === this.currentTurn - 1)?.text.trim();
      const instruction = 'The previous turn stopped unexpectedly. Inspect the current state and recent work before acting. Continue only what remains from my previous request; verify before repeating any action. Tell me what you recovered.';
      this.draft = `${instruction}${lastRequest ? `\n\nPrevious request for reference:\n${lastRequest}` : ''}${this.draft.trim() ? `\n\nAdditional note:\n${this.draft.trim()}` : ''}`;
      this.recoveryPrepared = true;
    }
    void this.updateComplete.then(() => this.shadowRoot?.querySelector<HTMLTextAreaElement>('.composer-row textarea')?.focus());
  }
  private async stop() {
    if (!this.busy || this.stopping) return;
    this.stopping = true;
    try {
      const response = await fetch(apiPath(`/api/sdk-chats/${encodeURIComponent(this.sessionId)}/interrupt`), { method:'POST' });
      if (!response.ok) throw new Error(await response.text());
      this.error = '';
    } catch (error) { this.error = String(error); }
    finally { this.stopping = false; }
  }
  private async toggleVoice() {
    if (!this.voice || !this.voiceAvailable) return;
    if (this.voiceState !== 'idle') { this.voice.stop(); return; }
    if (this.draft.trim() || this.attachments.length || this.settingsPending) return;
    try { await this.voice.start(); this.error = ''; }
    catch (error) { this.error = error instanceof Error ? error.message : 'Voice could not start.'; }
  }
  private updateVoiceLevels(levels: readonly number[]) {
    const bars = this.renderRoot.querySelectorAll<HTMLElement>('.send.voice-active .voice-bars i');
    const resting = [4, 6, 4, 6, 5];
    bars.forEach((bar, index) => { bar.style.height = `${Math.round(resting[index] + Math.min(1, levels[index] || 0) * 10)}px`; });
  }
  private sendVoiceButton() {
    const mode = this.voiceState !== 'idle' ? 'voice-stop' : this.busy ? 'task-stop' : this.draft.trim() || this.attachments.length ? 'send' : 'voice-start';
    const label = mode === 'voice-stop' ? 'Stop voice mode' : mode === 'task-stop' ? 'Stop current task' : mode === 'send' ? 'Send message' : 'Start voice mode';
    const disabled = mode === 'voice-start' ? !this.voiceAvailable || this.settingsPending
      : mode === 'task-stop' ? this.stopping
      : mode === 'send' ? this.stopping || this.settingsPending || this.attachments.some(a => a.uploading || !!a.error)
      : false;
    const bars = html`<span class="voice-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`;
    const glyph = mode === 'voice-start' ? bars : mode === 'voice-stop' ? html`${bars}<span aria-hidden="true">Stop</span>`
      : mode === 'send' ? html`<span aria-hidden="true">↑</span>` : html`<span aria-hidden="true">■</span>`;
    return html`<button class="send ${mode === 'voice-stop' ? 'voice-active' : ''}" aria-label=${label} title=${label} ?disabled=${disabled} @click=${() => mode === 'voice-start' || mode === 'voice-stop' ? void this.toggleVoice() : mode === 'task-stop' ? void this.stop() : void this.send()}>${keyed(mode, html`<span class="send-icon">${glyph}</span>`)}</button>`;
  }
  private isACPChat() { return this.chat?.harness === 'pi' || this.chat?.harness === 'opencode' || this.chat?.harness === 'deepseek'; }
  override render() {
    const agents = this.agents();
    return html`
    <div class="topbar">${this.selectedAgent ? this.agentBreadcrumbs(agents) : html`<div class="chat-title"><h1 title=${this.scheduledJob?.name || this.chat?.title || 'Chat'}>${this.scheduledJob?.name || this.chat?.title || 'Chat'}</h1></div>`}<div class="pane-controls" role="group" aria-label="Chat pane layout"><button class=${!this.drawerOpen ? 'active' : ''} aria-label="Chat only" title="Chat only" aria-pressed=${!this.drawerOpen} @click=${() => this.setPaneMode('chat')}>${icon(PanelLeft,{size:17})}</button><button class=${this.drawerOpen && !this.previewFocused ? 'active' : ''} aria-label="Split chat and preview" title="Split chat and preview" aria-pressed=${this.drawerOpen && !this.previewFocused} @click=${() => this.setPaneMode('split')}>${icon(Columns2,{size:17})}</button><button class=${this.previewFocused ? 'active' : ''} aria-label="Preview only" title="Preview only" aria-pressed=${this.previewFocused} @click=${() => this.setPaneMode('preview')}>${icon(PanelRight,{size:17})}</button></div></div>
    <div class="layout ${this.previewFocused ? 'preview-focused' : ''}" @dragenter=${this.onDragEnter} @dragover=${this.onDragOver} @dragleave=${this.onDragLeave} @drop=${this.onDrop}><div class="chat">
      ${this.agentHistoryError ? html`<div class="agent-history-error" role="alert">Saved agent work could not be loaded. <button @click=${this.retryAgentHistory}>Retry</button></div>` : nothing}
      ${this.recoveryRequired ? html`<div class="recovery" role="alert"><strong>Turn interrupted</strong><p>The harness stopped before confirming how the last turn ended. Some work may have happened. Review a recovery message, then send it to continue this chat.</p><button @click=${this.prepareRecovery}>${this.recoveryPrepared ? 'Review recovery draft' : 'Prepare recovery message'}</button></div>` : nothing}
      <div class="body" @scroll=${this.onBodyScroll} @wheel=${() => { this.historyUserInteracted = true; }} @touchstart=${() => { this.historyUserInteracted = true; }} @pointerdown=${() => { this.historyUserInteracted = true; }}>
      ${this.selectedAgent ? this.agentWork(agents.find(agent => agent.id === this.selectedAgent)) : this.blocks.length ? this.transcript(agents) : html`<div class="block">Loading recent messages…</div>`}
      ${this.error ? html`<div class="block error" role="alert">${this.error}${this.reconnectFailed ? html` <button @click=${this.retryConnection}>Retry now</button>` : nothing}</div>` : nothing}
    </div>${this.showScrollBottom ? html`<div class="scroll-bottom-row"><button class="scroll-bottom" aria-label="Scroll to bottom" @click=${() => void this.scrollToBottom()}>↓ Scroll to bottom</button></div>` : nothing}<div class="composer-wrap"><div class="composer" @paste=${this.onPaste}>
      ${this.voiceState !== 'idle' ? html`<div class="voice-compose-row"><input class="file-input" type="file" multiple @change=${this.onPick} aria-label="Choose files to attach"><button class="voice-attach" aria-label="Attach files for later" title="Attach files for later" @click=${() => this.shadowRoot?.querySelector<HTMLInputElement>('.file-input')?.click()}>＋</button><span class="voice-label" role="status" aria-live="polite">${this.voiceState === 'connecting' ? 'Connecting…' : this.voiceState === 'speaking' ? 'Speaking…' : 'Listening…'}</span><span class="voice-mic" aria-hidden="true">${icon(Mic, { size:17 })}</span>${this.sendVoiceButton()}</div>` : this.selectedAgent ? html`<div class="composer-row"><textarea aria-label="Steer delegated agent through root" placeholder="Ask the root to steer this agent…" .value=${this.agentDraft} @input=${(e: InputEvent) => { this.agentDraft=(e.target as HTMLTextAreaElement).value; }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.steerAgent(); } }}></textarea></div><div class="composer-controls"><span class="agent-notice">${this.agentNotice}</span>${this.busy ? html`<button class="stop" aria-label="Stop root turn and delegated agent" title="Stop root turn and delegated agent" ?disabled=${this.stopping} @click=${() => void this.stop()}>■</button>` : nothing}<button class="steer" @click=${() => void this.steerAgent()} ?disabled=${!this.agentDraft.trim()}>Send to root ↗</button></div>` : html`
      ${this.attachments.length ? html`<div class="attachments" aria-label="Attached files">${this.attachments.map(a => html`<div class="attachment">
        ${a.preview ? html`<img src=${a.preview} alt=${a.file.name}>` : nothing}
        <span class="filename" title=${a.file.name}>${a.file.name}</span>
        <span class="status ${a.error ? 'failed' : ''}" role=${a.error ? 'alert' : 'status'}>${a.error || (a.uploading ? 'Uploading…' : '')}</span>
        <button aria-label=${`Remove ${a.file.name}`} @click=${() => this.removeAttachment(a.localId)}>×</button>
      </div>`)}</div>` : nothing}
      <div class="composer-row"><textarea aria-label=${this.busy && this.isACPChat() ? 'Message after current turn' : this.busy ? 'Steer running turn' : 'Message'} placeholder=${this.busy && this.isACPChat() ? 'Wait for this turn to finish, or stop it…' : this.busy ? 'Steer this turn…' : `Message ${this.chat?.harness || 'agent'}…`} .value=${this.draft} @input=${(e: InputEvent) => { this.draft = (e.target as HTMLTextAreaElement).value; }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.send(); } }}></textarea></div>
      <div class="composer-controls"><input class="file-input" type="file" multiple @change=${this.onPick} aria-label="Choose files to attach"><button class="attach-button" aria-label="Attach files or images" title="Attach files or images" @click=${() => this.shadowRoot?.querySelector<HTMLInputElement>('.file-input')?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5L13 2.5a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg></button><mux-sdk-chat-settings .sessionId=${this.sessionId} .harness=${this.chat?.harness || ''} .turnBusy=${this.busy} @settings-pending=${(e: CustomEvent<boolean>) => { this.settingsPending = e.detail; }}></mux-sdk-chat-settings>${this.sendVoiceButton()}</div>`}

    </div></div></div>
      ${this.drawerOpen ? keyed(this.sessionId, html`<aside class="drawer" aria-label="Right drawer" style=${`--utility-width:${this.drawerWidth}px`}><div class="drawer-resizer" role="separator" aria-label="Resize right drawer" aria-orientation="vertical" tabindex="0" @pointerdown=${this.startDrawerResize} @pointermove=${this.moveDrawerResize} @pointerup=${this.endDrawerResize} @lostpointercapture=${this.endDrawerResize} @keydown=${(e: KeyboardEvent) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const {min,max}=this.widthLimits(); this.drawerWidth=Math.round(Math.max(min,Math.min(max,this.drawerWidth+(e.key === 'ArrowLeft' ? 20 : -20)))); try { localStorage.setItem(this.drawerKey(),String(this.drawerWidth)); } catch { /* private browsing */ } e.preventDefault(); } }}></div><mux-sdk-utility .sessionId=${this.sessionId} .projectPath=${this.chat?.projectPath || ''} .chatTitle=${this.chat?.title || ''} .terminalWorkspaceId=${this.chat?.terminalWorkspaceId || ''} .focused=${this.previewFocused} .touched=${this.touchedFiles()} @sdk-file-reference=${this.stageFileReference} @sdk-page-prompt=${this.stagePagePrompt} @sdk-file-focus=${() => this.setPaneMode(this.previewFocused ? 'split' : 'preview')}></mux-sdk-utility></aside>`) : nothing}
    </div>${this.dropActive ? html`<div class="drop-overlay" role="status">Drop files to attach</div>` : nothing}`;
  }
}
