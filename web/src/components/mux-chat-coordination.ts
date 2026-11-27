import { LitElement, css, html, nothing, svg, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { chatHost, remoteChatPath } from '../lib/remote-chat-routes.js';
import { sdkChats } from '../lib/sdk-chats.js';
import { parseMarkdown } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import '../ui/button.js';
import '../ui/range-field.js';
import '../ui/select.js';
import '../ui/text-area.js';
import '../ui/text-field.js';
import '../ui/switch.js';
import './work-goal-review.js';
import type { MuxUIRangeField } from '../ui/range-field.js';
import type { MuxUISelect } from '../ui/select.js';
import type { MuxUITextArea } from '../ui/text-area.js';
import type { MuxUITextField } from '../ui/text-field.js';

type GitHubIncomingIssue = {number:number; title:string; assignees:{login:string}[]};
type WorkActor = { kind: 'chat' | 'remote-chat' | 'human' | 'external-tool'; sessionId?: string };
type WorkDispatch = { clientRef: string; sessionId: string; state: string; detail?: string; selectionReason?: string; choiceSource?: string; goalMode?: 'native' | 'muxterm-work'; contextWorkId?: string; fallback?: string; configuration?: { harness: string; provider: string; bundle?: string; model?: string; effort?: string } };
type WorkStep = { id: string; title: string; status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped' };
type WorkCompletion = {reason: string; resolutions?: {id: string; status: string; reason: string}[]; reviewedUnreadComments?: boolean};
type WorkUpdate = { completion?: WorkCompletion; id: string; at: string; actor?: WorkActor; sessionId?: string; linkedSessionId?: string; summary?: string; text: string; harness?: string; comment?: boolean; commentPriority?: 'normal' | 'high'; commentSource?: string; commentReadThrough?: string; commentNoticeState?: string; title?: string; brief?: string; acceptanceCriteria?: string; goalCondition?: string; goalApproved?: boolean; status?: string; readiness?: string; progress?: string; nextAction?: string; outcome?: string; evidence?: string[]; ownerSessionId?: string; blockedReason?: string; needsHuman?: boolean; planBefore?: WorkStep[]; planAfter?: WorkStep[]; planReason?: string; stepUpdates?: {id:string;status:WorkStep['status']}[] };
type WorkChatGoal = { requestedRevision:number; appliedRevision:number; controlVersion:number; state:string; humanPaused:boolean; receipts:{id:string; action:string; status:string; detail?:string}[] };
type WorkItem = { id: string; reference?: string; title: string; brief: string; harness?: string; source?: string; status: string; readiness?: string; heldByHuman?: boolean; needsHuman?: boolean; progress?: string; nextAction?: string; outcome?: string; createdBy: WorkActor; ownerSessionId: string; reviewerSessionId?: string; acceptanceCriteria?: string; goalCondition?: string; goalRevision?: number; goalFiledRevision?: number; goalReplacement?: { clientRef:string; condition:string; workRevision:number; controlVersion:number }; goalObservation?: { eventId:string; state:string; summary?:string; at:string }; goalApprovedRevision?: number; blockedReason?: string; plan?: WorkStep[]; planRevision?: number; planProtocol?: string; dependsOn: string[]; waitingOn: string[]; graphId?: string; graphIntegrationId?: string; graphLinks?: string[]; labels: string[]; dispatch?: WorkDispatch; commentReadBy?: Record<string,string>; commentNotice?: {ownerSessionId:string; anchorId:string; state:string}; commentBoundary?: {ownerSessionId:string; anchorId:string; state:string}; revision: number; sessionIds: string[]; projectIds: string[]; updatedAt: string; createdAt: string; updates?: WorkUpdate[] };
type WorkControl = { projectId: string; paused: boolean; parallelism: number; version: number; active: number };
type DetailTab = 'description' | 'people' | 'plan' | 'activity';
const detailTabs: { id: DetailTab; label: string; icon: 'description' | 'ownership' | 'plan' | 'clock' }[] = [
  { id: 'description', label: 'Description', icon: 'description' },
  { id: 'people', label: 'Ownership', icon: 'ownership' },
  { id: 'plan', label: 'Plan', icon: 'plan' },
  { id: 'activity', label: 'Activity', icon: 'clock' },
];
const workHarnesses = ['codex', 'claude', 'copilot', 'amplifier', 'amplifier-unified', 'pi', 'opencode', 'deepseek', 'antigravity'];

function activityPreview(value: string): string {
  const plain = value.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(^|\n)\s*(?:#{1,6}\s+|[-*]\s+)/g, '$1')
    .replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim();
  const end = plain.search(/[.!?](?=\s|$)/);
  const sentence = end >= 0 && end < 160 ? plain.slice(0, end + 1) : plain;
  const characters = [...sentence];
  if (characters.length <= 160) return sentence;
  return characters.slice(0, 157).join('').replace(/\s+\S*$/, '').trimEnd() + '…';
}

const icon = (name: 'work' | 'folder' | 'play' | 'pause' | 'chevron' | 'back' | 'clock' | 'check' | 'chat' | 'wait' | 'alert' | 'flag' | 'description' | 'ownership' | 'plan') => {
  const paths = {
    description: svg`<path d="M6 3h9l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M15 3v5h4M8 12h8M8 16h8"/>`,
    ownership: svg`<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2H3Zm13-15a3 3 0 0 1 0 6m1 3a5 5 0 0 1 4 5v1h-3"/>`,
    plan: svg`<path d="M10 6h11M10 12h11M10 18h11M3 6h2M3 12h2M3 18h2"/>`,
    work: svg`<path d="M13 5h8M13 12h8M13 19h8m-18-2 2 2 4-4"/><rect x="3" y="4" width="6" height="6" rx="1"/>`,
    folder: svg`<path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"/>`,
    play: svg`<path d="M6 4.5a1 1 0 0 1 1.5-.86l12 7a1.6 1.6 0 0 1 0 2.72l-12 7A1 1 0 0 1 6 19.5z"/>`,
    pause: svg`<rect x="5" y="3" width="5" height="18" rx="1"/><rect x="14" y="3" width="5" height="18" rx="1"/>`,
    chevron: svg`<path d="m6 9 6 6 6-6"/>`,
    back: svg`<path d="m15 18-6-6 6-6"/>`,
    clock: svg`<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`,
    check: svg`<path d="m4 12 5 5L20 6"/>`,
    chat: svg`<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 12.5 3a8.5 8.5 0 0 1 8.5 8.5z"/>`,
    wait: svg`<path d="M7 4h10M7 20h10M8 4c0 4 4 4 4 8s-4 4-4 8m8-16c0 4-4 4-4 8s4 4 4 8"/>`,
    alert: svg`<path d="m10.3 3.9-8.1 14a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3l-8.1-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>`,
    flag: svg`<path d="M5 21V4m0 1c5-3 9 3 14 0v11c-5 3-9-3-14 0"/>`,
  };
  return html`<svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};

@customElement('mux-chat-coordination')
export class MuxChatCoordination extends LitElement {
  @property() sessionId = '';
  @property() projectId = '';
  @property() remoteHost = '';
  @state() private work: WorkItem[] = [];
  @state() private detail?: WorkItem;
  @state() private chatGoal?: { path:string; document:WorkChatGoal };
  @state() private unmatchedGoalPath = '';
  @state() private goalSending = false;
  @state() private goalError = '';
  @state() private replacementDraft?: { workId:string; revision:number; controlVersion:number; condition:string; clientRef:string };
  @state() private dependencyReferences: Record<string,WorkItem> = {};
  private loadingDependencies = new Set<string>();
  @state() private control?: WorkControl;
  @state() private filter: 'open' | 'all' | 'finished' = 'open';
  @state() private labelFilter = '';
  @state() private collapsed: Record<string, boolean> = {};
  @state() private error = '';
  @state() private commentDraft = '';
  @state() private commentPriority: 'normal' | 'high' = 'normal';
  @state() private commentSending = false;
  @state() private ackSending = false;
  @state() private harnessSaving = false;
  @state() private selectedTab: DetailTab = 'description';
  private selectedTabKey = '';
  private commentRef = '';
  private commentRefBody = '';
  private ackRef = '';
  private ackThrough = '';
  private poll?: number;
  private loading = false;
  private refreshKey = 0;

  static styles = css`
    :host { display:block; height:100%; overflow:auto; box-sizing:border-box; background:var(--ui-surface-base); color:var(--ui-text); font:var(--ui-text-lg)/1.55 var(--ui-font-sans); }
    * { box-sizing:border-box; }

    .wrap { max-width:var(--ui-chat-content-width); margin:0 auto; padding:var(--ui-space-9) var(--ui-space-9) var(--ui-space-13); }
    .detail-wrap { max-width:var(--ui-work-wrap-width); }
    .detail-view { max-width:var(--ui-work-detail-width); }
    h2,h3,p { margin:0; }
    h2 { font-size:var(--ui-text-3xl); line-height:1.15; letter-spacing:-.035em; }
    h3 { font-size:var(--ui-text-md); line-height:1.35; }
    .top { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--ui-space-7); }
    .project { display:flex; align-items:center; gap:var(--ui-space-4); margin-top:var(--ui-space-4); color:var(--ui-text-muted); font-size:var(--ui-text-md); }
    .icon { flex:none; }
    .top .icon { color:var(--ui-accent); }
    .controls { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--ui-space-6); margin:var(--ui-space-7) 0 var(--ui-space-8); }
    .controls-main { display:flex; align-items:center; gap:var(--ui-space-5); }
    .play { flex:none; }
    .active-count { color:var(--ui-text-muted); font-size:var(--ui-text-md); }
    .parallel { display:flex; align-items:center; color:var(--ui-text-muted); }
    .parallel mux-ui-range-field { width:var(--ui-work-parallel-width); }

    .filters { display:flex; align-items:center; gap:var(--ui-space-7); margin:var(--ui-space-7) 0 0; color:var(--ui-text-muted); font-size:var(--ui-text-md); }
    .filter::part(button) { padding-inline:var(--ui-space-3); }
    .filter[selected] { color:var(--ui-text); font-weight:700; }
    .label-filter { margin-left:auto; max-width:var(--ui-work-filter-width); }
    .attention { padding:var(--ui-space-8); margin:var(--ui-space-7) 0 var(--ui-space-9); border-radius:var(--ui-radius-xl); background:color-mix(in srgb, var(--ui-warning) 11%, var(--ui-surface-raised)); }
    .attention-item + .attention-item { margin-top:var(--ui-space-7); }
    .attention .kind { display:flex; align-items:center; gap:var(--ui-space-4); color:var(--ui-warning); font-size:var(--ui-text-md); font-weight:700; }
    .attention .kind.review { color:var(--ui-accent); }
    .attention .kind.blocked { color:var(--ui-danger); }
    .attention mux-ui-button,.row mux-ui-button { max-width:100%; }
    .attention mux-ui-button::part(button),.row mux-ui-button::part(button) { justify-content:flex-start; flex-wrap:wrap; padding:0; min-height:0; white-space:normal; text-align:left; }
    .attention mux-ui-button:hover,.row mux-ui-button:hover { color:var(--ui-accent); }
    .attention h3 { flex:1 1 12rem; min-width:0; margin-top:var(--ui-space-3); font-size:var(--ui-text-lg); overflow-wrap:anywhere; }
    .attention p,.row p { margin-top:var(--ui-space-2); color:var(--ui-text-muted); font-size:var(--ui-text-md); overflow-wrap:anywhere; }
    .group { margin-top:var(--ui-space-8); }
    .group-head { display:block; width:100%; }
    .group-head::part(button) { display:flex; justify-content:flex-start; gap:var(--ui-space-4); min-height:0; padding:0; white-space:normal; font-size:var(--ui-text-lg); font-weight:700; }
    .group-head .count { margin-left:auto; color:var(--ui-text-muted); font-size:var(--ui-text-xs); font-weight:500; }
    .group-head .chevron { color:var(--ui-text-muted); transform:rotate(0); transition:transform .15s ease; }
    .group-head:not([expanded]) .chevron { transform:rotate(-90deg); }
    .group-body { padding-top:var(--ui-space-3); }
    .row { padding:var(--ui-space-5) var(--ui-space-4) var(--ui-space-5) var(--ui-space-8); border-radius:var(--ui-radius-lg); }
    .row:hover { background:var(--ui-surface-hover); }
    .row .kind { display:flex; align-items:center; gap:var(--ui-space-3); color:var(--ui-text-muted); font-size:var(--ui-text-md); font-weight:650; }
    .row .kind.working { color:var(--ui-accent); }
    .row .kind.waiting { color:var(--ui-warning); }
    .row .kind.blocked { color:var(--ui-danger); }
    .row .kind.ready { color:var(--ui-success); }
    .row strong { display:block; flex:1 1 12rem; min-width:0; margin-top:var(--ui-space-2); font-size:var(--ui-text-lg); font-weight:650; overflow-wrap:anywhere; }
    .work-reference { display:inline-flex; flex:none; width:max-content; max-width:100%; align-items:center; white-space:nowrap; border-radius:var(--ui-radius-sm); padding:0 var(--ui-space-2); background:color-mix(in srgb,var(--ui-accent) 10%,transparent); color:var(--ui-accent); font-size:var(--ui-text-sm); font-weight:700; text-decoration:underline; text-underline-offset:2px; }
    .work-dependency-reference { overflow-wrap:anywhere; }
    .work-links { display:grid; gap:var(--ui-space-4); margin:0; padding:0; list-style:none; }
    .work-links li { display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--ui-space-2) var(--ui-space-5); }
    .work-links li span { font-size:85%; }
    .work-reference-detail { margin-bottom:var(--ui-space-3); }
    .work-reference-host { margin-left:var(--ui-space-3); color:var(--ui-text-muted); font-size:var(--ui-text-sm); overflow-wrap:anywhere; }
    .row .work-reference { margin-top:var(--ui-space-2); }
    .attention .work-reference { margin-top:var(--ui-space-3); }
    .row .meta { margin-top:var(--ui-space-2); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .empty { padding:var(--ui-space-8) 0; color:var(--ui-text-muted); }
    .empty strong { display:block; color:var(--ui-text); }
    .back { display:block; width:max-content; margin-bottom:var(--ui-space-7); color:var(--ui-text); }
    .back:hover { color:var(--ui-accent); }
    .detail-project { margin:0 0 var(--ui-space-8); }
    .status { display:flex; align-items:center; gap:var(--ui-space-3); width:max-content; margin-bottom:var(--ui-space-4); color:var(--ui-accent); font-size:var(--ui-text-md); font-weight:700; }
    .status.waiting { color:var(--ui-warning); }
    .status.blocked { color:var(--ui-danger); }
    .status.done { color:var(--ui-success); }
    .detail-view { min-width:0; container-type:inline-size; }
    .detail-view h2 { overflow-wrap:anywhere; }
    .detail-tabs { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--ui-space-2); margin-top:var(--ui-space-8); border-bottom:1px solid var(--ui-border); }
    .detail-tab { display:flex; min-width:0; }
    .detail-tab::part(button) { display:flex; align-items:center; justify-content:center; gap:var(--ui-space-3); min-width:0; min-height:var(--ui-control-lg); padding:var(--ui-space-3) var(--ui-space-4); border:1px solid transparent; border-bottom:0; border-radius:var(--ui-radius-md) var(--ui-radius-md) 0 0; background:transparent; color:var(--ui-text-muted); font:600 var(--ui-text-sm)/1.25 var(--ui-font-sans); text-align:center; white-space:normal; }
    .detail-tab:hover::part(button) { color:var(--ui-text); background:var(--ui-surface-hover); }
    .detail-tab[tab-selected]::part(button) { color:var(--ui-text); background:var(--ui-surface-raised); border-color:var(--ui-border); box-shadow:0 1px 0 var(--ui-surface-raised); }
    .detail-tab-label { min-width:0; overflow-wrap:anywhere; }
    .detail-tab-count { flex:none; display:inline-grid; place-items:center; min-width:1.5em; padding:0 var(--ui-space-2); border-radius:var(--ui-radius-pill); background:var(--ui-surface-hover); font-size:var(--ui-text-xs); }
    .detail-panel { min-width:0; padding-top:var(--ui-space-7); }
    .detail-panel > .plan:first-child,.detail-panel > .next:first-child,.detail-panel > .section:first-child { margin-top:0; }
    .detail-panel:focus { outline:none; }
    .detail-panel:focus-visible { outline:var(--ui-space-1) solid var(--ui-accent); outline-offset:var(--ui-space-2); }
    .next-brief { margin-top:var(--ui-space-6); padding:var(--ui-space-5) var(--ui-space-7); border-left:3px solid var(--ui-accent); background:color-mix(in srgb,var(--ui-accent) 7%,var(--ui-surface-raised)); border-radius:0 var(--ui-radius-md) var(--ui-radius-md) 0; }
    .next-brief.blocked { border-color:var(--ui-danger); background:color-mix(in srgb,var(--ui-danger) 7%,var(--ui-surface-raised)); }
    .next-brief strong { display:block; color:var(--ui-accent); font-size:var(--ui-text-sm); }
    .next-brief.blocked strong { color:var(--ui-danger); }
    .next-brief p { margin-top:var(--ui-space-1); overflow-wrap:anywhere; }
    .next { margin-top:var(--ui-space-9); padding:var(--ui-space-7) var(--ui-space-8); border-radius:var(--ui-radius-xl); background:color-mix(in srgb,var(--ui-accent) 9%,var(--ui-surface-raised)); }
    .next h3 { color:var(--ui-accent); }
    .next.blocked { background:color-mix(in srgb,var(--ui-danger) 8%,var(--ui-surface-raised)); }
    .next.blocked h3 { color:var(--ui-danger); }
    .next p { margin-top:var(--ui-space-4); font-size:var(--ui-text-lg); white-space:pre-wrap; overflow-wrap:anywhere; }
    .plan { margin-top:var(--ui-space-9); padding:var(--ui-space-7) var(--ui-space-8); border:1px solid var(--ui-border); border-radius:var(--ui-radius-xl); background:var(--ui-surface-raised); }
    .plan-head { display:flex; align-items:baseline; justify-content:space-between; flex-wrap:wrap; gap:var(--ui-space-3); }
    .plan-count { color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
    .plan progress { display:block; width:100%; height:var(--ui-space-3); margin:var(--ui-space-5) 0 var(--ui-space-6); accent-color:var(--ui-accent); }
    .plan-list { list-style:none; margin:0; padding:0; }
    .plan-list li { display:flex; gap:var(--ui-space-4); padding:var(--ui-space-3) 0; border-top:1px solid var(--ui-border); }
    .plan-list .step-state { flex:none; width:var(--ui-space-13); color:var(--ui-text-muted); font-size:var(--ui-text-sm); font-weight:650; }
    .plan-list .step-state.done { color:var(--ui-success); }
    .plan-list .step-state.blocked { color:var(--ui-danger); }
    .plan-list .step-state.in_progress { color:var(--ui-accent); }
    .plan-list .step-title { min-width:0; overflow-wrap:anywhere; }
    .plan-protocol { margin-top:var(--ui-space-5); color:var(--ui-text-muted); font-size:var(--ui-text-sm); white-space:pre-wrap; }
    mux-work-goal-review { display:block; min-width:0; }
    .section { margin-top:var(--ui-space-9); }
    .section h3 { margin-bottom:var(--ui-space-4); }
    .section p { color:var(--ui-text-muted); white-space:pre-wrap; overflow-wrap:anywhere; }
    .facts { display:flex; flex-wrap:wrap; gap:var(--ui-space-5) var(--ui-space-7); margin-top:var(--ui-space-9); color:var(--ui-text-muted); font-size:var(--ui-text-md); }
    .facts span { display:inline-flex; align-items:center; gap:var(--ui-space-2); }
    .facts .icon { width:var(--ui-icon-sm); height:var(--ui-icon-sm); }
    a { color:var(--ui-accent); text-decoration:underline; text-underline-offset:var(--ui-space-2); }
    a[href^='#chat='],.work-dependency-reference { -webkit-user-select:none; user-select:none; }
    .tags { display:flex; flex-wrap:wrap; gap:var(--ui-space-4); margin-top:var(--ui-space-4); }
    .tag { display:inline-flex; border-radius:var(--ui-radius-md); padding:var(--ui-space-2) var(--ui-space-5); background:var(--ui-surface-raised); color:var(--ui-text); font-size:var(--ui-text-md); font-weight:600; }
    .timeline { position:relative; list-style:none; margin:var(--ui-space-6) 0 0; padding:0; }
    .timeline:before { content:''; position:absolute; left:var(--ui-space-5); top:var(--ui-space-6); bottom:var(--ui-space-8); width:var(--ui-space-px); background:var(--ui-border); }
    .timeline > li { position:relative; display:grid; grid-template-columns:var(--ui-space-8) minmax(0,1fr); gap:var(--ui-space-5); padding:0 0 var(--ui-space-7); }
    .timeline-icon { display:grid; place-items:center; width:var(--ui-space-8); height:var(--ui-space-8); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); color:var(--ui-accent); }
    .timeline-icon .icon { width:var(--ui-space-6); height:var(--ui-space-6); }
    .timeline time { color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .timeline > li > div > strong { display:block; margin-top:var(--ui-space-1); font-weight:650; }
    .timeline p { margin-top:var(--ui-space-2); color:var(--ui-text-muted); overflow-wrap:anywhere; }
    .activity-summary { max-width:65ch; line-height:1.5; }
    .activity-full { margin-top:var(--ui-space-2); }
    .activity-full > summary { width:max-content; max-width:100%; color:var(--ui-accent); font-size:var(--ui-text-md); font-weight:600; cursor:pointer; -webkit-user-select:none; user-select:none; }
    .activity-full > summary:hover { text-decoration:underline; text-underline-offset:var(--ui-space-2); }
    .activity-markdown { max-width:70ch; margin-top:var(--ui-space-3); color:var(--ui-text-muted); overflow-wrap:anywhere; }
    .activity-markdown > :first-child { margin-top:0; }
    .activity-markdown .md-p { margin:var(--ui-space-3) 0 0; white-space:normal; }
    .activity-markdown .md-ul,.activity-markdown .md-ol { margin:var(--ui-space-3) 0; padding-left:var(--ui-space-7); }
    .activity-markdown .md-li + .md-li { margin-top:var(--ui-space-2); }
    .activity-markdown .md-li .md-p { margin:0; }
    .activity-markdown .md-code { padding:var(--ui-space-px) var(--ui-space-2); border-radius:var(--ui-radius-sm); background:var(--ui-surface-raised); color:var(--ui-text); font:var(--ui-text-md) var(--ui-font-mono); }
    .activity-markdown .md-pre { max-width:100%; padding:var(--ui-space-4); overflow:auto; border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); font:var(--ui-text-md) var(--ui-font-mono); }
    .activity-markdown .md-quote { margin:var(--ui-space-3) 0; padding-left:var(--ui-space-4); border-left:var(--ui-space-px) solid var(--ui-border); }
    .activity-markdown .md-tablewrap { max-width:100%; overflow:auto; }
    .activity-markdown .md-table { border-collapse:collapse; }
    .activity-markdown .md-th,.activity-markdown .md-td { padding:var(--ui-space-2) var(--ui-space-3); border-bottom:var(--ui-space-px) solid var(--ui-border); text-align:left; }
    .activity-markdown .md-h { margin:var(--ui-space-4) 0 var(--ui-space-2); font-size:var(--ui-text-lg); }
    .completion-form { display:grid; gap:var(--ui-space-3); padding:var(--ui-space-3); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); overflow-wrap:anywhere; }
    .completion-form fieldset { display:grid; gap:var(--ui-space-3); min-width:0; margin:0; border:1px solid var(--ui-border); }
    .completion-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:var(--ui-space-2); }
    .activity-evidence { margin-top:var(--ui-space-3); font-size:var(--ui-text-md); }
    .comment-form { margin-top:var(--ui-space-6); display:grid; gap:var(--ui-space-3); }
    .comment-form mux-ui-text-area { width:100%; }
    .comment-form mux-ui-button { justify-self:start; }
    .comment-body { white-space:pre-wrap; overflow-wrap:anywhere; }
    .comment-meta { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); margin-top:var(--ui-space-2); color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .comment-priority { color:var(--ui-accent); font-weight:700; }
    .comment-priority.high { color:var(--ui-danger); }
    .comment-attention { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--ui-space-3); margin-top:var(--ui-space-4); padding:var(--ui-space-4); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-raised); }
    .comment-attention strong { font-size:var(--ui-text-sm); }
    .comment-priority-field { display:flex; align-items:center; gap:var(--ui-space-3); flex-wrap:wrap; font-size:var(--ui-text-sm); }
    .comment-priority-field mux-ui-select { min-width:var(--ui-work-filter-width); }
    @media (max-width:390px) { .comment-attention mux-ui-button, .comment-form > mux-ui-button { width:100%; justify-self:stretch; } }
    .error { margin:var(--ui-space-5) 0; color:var(--ui-danger); }
    :focus-visible { outline:var(--ui-space-1) solid var(--ui-accent); outline-offset:var(--ui-space-2); }
    @container (max-width:700px) { .detail-tabs { grid-template-columns:repeat(2,minmax(0,1fr)); border-bottom:0; gap:var(--ui-space-2); } .detail-tab::part(button) { border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); } .detail-tab[tab-selected]::part(button) { border-color:var(--ui-accent); box-shadow:none; } }
    @media(max-width:560px) { .wrap { padding:var(--ui-space-8) var(--ui-space-7) var(--ui-control-lg); } .controls { align-items:flex-start; } .parallel { width:100%; justify-content:flex-start; } .parallel mux-ui-range-field { width:100%; } .label-filter { max-width:var(--ui-work-filter-width); } .detail-tab::part(button) { padding-inline:var(--ui-space-2); } }
    @media(prefers-reduced-motion:reduce) { .group-head .chevron { transition:none; } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.poll = window.setInterval(() => { if (!document.hidden) void this.refresh(); }, 3000);
  }
  override disconnectedCallback() {
    if (this.poll) window.clearInterval(this.poll);
    this.refreshKey++;
    this.loading = false;
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues<this>) {
    if (changed.has('sessionId') || changed.has('projectId') || changed.has('remoteHost')) {
      this.refreshKey++;
      this.loading = false;
      this.work = [];
      this.detail = undefined;
      this.control = undefined;
      this.labelFilter = '';
      this.githubRepo = localStorage.getItem(`work-github-repo:${this.projectId}`) ?? '';
      this.githubIssues = undefined;
      this.githubError = '';
      this.githubSyncing = false;
      void this.refresh();
    }
  }
  private path(path: string) { return apiPath(remoteChatPath(this.remoteHost, path)); }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.path(path), { cache: 'no-store', ...init });
    if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
    return await response.json() as T;
  }
  private workChatGoalPath(item?: WorkItem) {
    if (!item?.ownerSessionId || !['active', 'blocked'].includes(item.status)) return '';
    return `/api/sdk-chats/${encodeURIComponent(item.ownerSessionId)}/goal?workId=${encodeURIComponent(item.id)}`;
  }
  private async refreshWorkChatGoal() {
    const path = this.workChatGoalPath(this.detail);
    if (!path) {
      this.chatGoal = undefined;
      return;
    }
    try {
      const response = await fetch(this.path(path), { cache: 'no-store' });
      const document = response.ok ? await response.json() as WorkChatGoal : undefined;
      if (!this.goalSending && path === this.workChatGoalPath(this.detail)) {
        this.chatGoal = document ? { path, document } : undefined;
        this.unmatchedGoalPath = response.status === 409 ? path : '';
      }
    } catch {
      if (!this.goalSending && path === this.workChatGoalPath(this.detail)) this.chatGoal = undefined;
    }
  }
  private async controlWorkChatGoal(action: 'pause' | 'resume') {
    const goal = this.chatGoal;
    if (!goal || this.goalSending || goal.path !== this.workChatGoalPath(this.detail)) return;
    this.goalSending = true;
    this.goalError = '';
    try {
      const document = await this.request<WorkChatGoal>(goal.path, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, clientRef: crypto.randomUUID(), expectedVersion: goal.document.controlVersion, workRevision: this.detail?.revision }),
      });
      if (goal.path === this.workChatGoalPath(this.detail)) this.chatGoal = { path: goal.path, document };
    } catch (error) {
      if (goal.path === this.workChatGoalPath(this.detail)) this.goalError = String(error);
    } finally {
      this.goalSending = false;
      void this.refreshWorkChatGoal();
    }
  }
  private async approveGoalReplacement() {
    const draft = this.replacementDraft;
    if (!draft || this.detail?.id !== draft.workId || this.goalSending) return;
    this.goalSending = true;
    this.goalError = '';
    try {
      const item = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(draft.workId)}/goal-replace`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRef: draft.clientRef, condition: draft.condition, workRevision: draft.revision, controlVersion: draft.controlVersion }),
      });
      if (this.detail?.id === draft.workId) this.detail = item;
      this.replacementDraft = undefined;
    } catch (error) {
      if (this.detail?.id === draft.workId) this.goalError = String(error);
    } finally {
      this.goalSending = false;
      void this.refreshWorkChatGoal();
    }
  }
  private renderWorkChatGoal(item: WorkItem) {
    const goal = this.chatGoal;
    const path = this.workChatGoalPath(item);
    if (!path) return nothing;
    if (item.goalReplacement) {
      const intent = item.goalReplacement;
      return html`<section class="section">
        <h3>Approved replacement</h3>
        <p>${intent.condition}</p>
        <p>The goal remains paused. Finish filing the approved condition before resuming.</p>
        <mux-ui-button variant="secondary" ?disabled=${this.goalSending} @click=${() => {
          this.replacementDraft = { workId:item.id, revision:intent.workRevision, controlVersion:intent.controlVersion, condition:intent.condition, clientRef:intent.clientRef };
          void this.approveGoalReplacement();
        }}>Finish replacement</mux-ui-button>
        ${this.goalError ? html`<p role="status">${this.goalError}</p>` : nothing}
      </section>`;
    }
    if (!goal || goal.path !== path) {
      return this.unmatchedGoalPath === path ? html`<p role="status">The owning chat has no current goal matching this Work condition.</p>` : nothing;
    }
    const latest = goal.document.receipts.findLast(receipt => ['pause', 'resume', 'set', 'approve', 'start', 'clear'].includes(receipt.action));
    const pending = goal.document.receipts.some(receipt => receipt.status === 'dispatching');
    const paused = goal.document.humanPaused;
    const uncertain = latest?.status === 'uncertain';
    const detail = this.goalError || (uncertain ? latest?.detail : '');
    const applied = goal.document.appliedRevision === goal.document.requestedRevision;
    const draft = this.replacementDraft?.workId === item.id ? this.replacementDraft : undefined;
    return html`<section class="section" aria-labelledby="work-chat-goal">
      <h3 id="work-chat-goal">Chat goal</h3>
      <p role="status">${pending ? latest?.action === 'pause' ? 'Pausing…' : latest?.action === 'resume' ? 'Resuming…' : 'Awaiting confirmation' : uncertain ? 'Delivery uncertain' : paused ? 'Paused by you' : goal.document.state}</p>
      <mux-ui-button variant="secondary" size="small" ?disabled=${pending || this.goalSending || !!draft || (paused && !applied)}
        @click=${() => void this.controlWorkChatGoal(paused ? 'resume' : 'pause')}>${paused ? 'Resume goal' : 'Pause goal'}</mux-ui-button>
      ${paused && applied && !pending && !uncertain && item.dispatch && !draft ? html`
        <mux-ui-button variant="quiet" size="small" @click=${() => {
          this.goalError = '';
          this.replacementDraft = { workId:item.id, revision:item.revision, controlVersion:goal.document.controlVersion, condition:'', clientRef:crypto.randomUUID() };
        }}>Replace goal</mux-ui-button>` : nothing}
      ${draft ? html`<form class="section" @submit=${(event: SubmitEvent) => { event.preventDefault(); void this.approveGoalReplacement(); }}>
        <mux-ui-text-area label="Replacement goal condition" .rows=${8} .maxLength=${4000} required .value=${draft.condition}
          @input=${(event: Event) => { this.replacementDraft = { ...draft, condition:(event.target as MuxUITextArea).value }; }}></mux-ui-text-area>
        <p>The owning chat and Work history are retained. The new condition stays paused until you resume it.</p>
        <mux-ui-button variant="secondary" ?disabled=${this.goalSending || !draft.condition.trim()} @click=${() => void this.approveGoalReplacement()}>Approve replacement</mux-ui-button>
        <mux-ui-button variant="quiet" ?disabled=${this.goalSending} @click=${() => { this.replacementDraft = undefined; }}>Cancel</mux-ui-button>
      </form>` : nothing}
      ${detail ? html`<p role="status">${detail}</p>` : nothing}
    </section>`;
  }

  private async refresh() {
    if (this.loading || (!this.projectId && !this.detail)) return;
    const key = this.refreshKey;
    this.loading = true;
    try {
      if (!this.projectId) {
        const selected = this.detail;
        if (!selected) return;
        const detail = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(selected.id)}`);
        if (key !== this.refreshKey || this.detail?.id !== detail.id) return;
        this.detail = detail;
      } else {
        const [items, control] = await Promise.all([
          this.request<{work: WorkItem[]}>(`/api/sdk-work?project_id=${encodeURIComponent(this.projectId)}`),
          this.request<WorkControl>(`/api/sdk-projects/${encodeURIComponent(this.projectId)}/work-control`),
        ]);
        if (key !== this.refreshKey) return;
        this.work = items.work;
        this.control = control;
        if (this.detail) {
          const detail = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(this.detail.id)}`);
          if (key !== this.refreshKey) return;
          this.detail = detail;
        }
      }
      await this.refreshWorkChatGoal();
      this.error = '';
    } catch (error) { if (key === this.refreshKey) this.error = String(error); }
    finally { if (key === this.refreshKey) this.loading = false; }
  }
  private async changeControl(changes: {paused?: boolean; parallelism?: number}) {
    if (!this.projectId || !this.control) return;
    try {
      this.control = await this.request<WorkControl>(`/api/sdk-projects/${encodeURIComponent(this.projectId)}/work-control`, { method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...changes, expectedVersion: this.control.version}) });
      this.error = '';
    } catch (error) { this.error = String(error); void this.refresh(); }
  }
  private async changeHarness(item: WorkItem, harness: string) {
    if (this.harnessSaving || item.harness === harness) return;
    this.harnessSaving = true;
    try {
      const updated = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(item.id)}/updates`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({clientRef: crypto.randomUUID(), expectedRevision: item.revision, harness,
          summary: harness ? `Selected ${harness} for Work` : 'Use AI default for Work'}),
      });
      if (this.detail?.id === item.id) this.detail = updated;
      this.error = '';
      void this.refresh();
    } catch (error) { this.error = String(error); void this.refresh(); }
    finally { this.harnessSaving = false; }
  }
  private async postComment() {
    const item = this.detail;
    const body = this.commentDraft.trim();
    if (!item || !body || this.commentSending) return;
    const commentKey = `${this.commentPriority}:${body}`;
    if (this.commentRefBody !== commentKey) {
      this.commentRef = crypto.randomUUID();
      this.commentRefBody = commentKey;
    }
    const commentRef = this.commentRef;
    this.commentSending = true;
    try {
      const posted = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(item.id)}/comments`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({clientRef: commentRef, text: body, priority: this.commentPriority}),
      });
      if (this.detail?.id === item.id) {
        this.detail = posted;
        if (this.commentDraft.trim() === body) {
          this.commentDraft = '';
          this.commentPriority = 'normal';
          this.commentRef = '';
          this.commentRefBody = '';
        }
        this.error = '';
      }
      void this.refresh();
    } catch (error) { this.error = String(error); }
    finally { this.commentSending = false; }
  }
  private comments(item: WorkItem) { return (item.updates || []).filter(update => update.comment); }
  private unreadComments(item: WorkItem) {
    const comments = this.comments(item);
    const cursor = item.commentReadBy?.[item.ownerSessionId];
    const index = comments.findIndex(comment => comment.id === cursor);
    return comments.slice(index + 1);
  }
  private async acknowledgeComments(item: WorkItem) {
    const unread = this.unreadComments(item);
    const through = unread.at(-1)?.id;
    if (!through || this.ackSending) return;
    if (this.ackThrough !== through) { this.ackRef = crypto.randomUUID(); this.ackThrough = through; }
    this.ackSending = true;
    try {
      const updated = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(item.id)}/comments/ack`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({clientRef: this.ackRef, throughCommentId: through}),
      });
      if (this.detail?.id === item.id) this.detail = updated;
      this.ackRef = '';
      this.ackThrough = '';
      this.error = '';
      void this.refresh();
    } catch (error) { this.error = String(error); }
    finally { this.ackSending = false; }
  }
  private projectName() { return sdkChats.projects.find(project => project.id === this.projectId && (project.remoteHost || '') === this.remoteHost)?.name || 'This project'; }
  private workProjectName(item: WorkItem) {
    const names = (item.projectIds || []).map(id => sdkChats.projects.find(project => project.id === id && (project.remoteHost || '') === this.remoteHost)?.name || id.slice(0, 8));
    return names.join(', ') || 'No project';
  }
  private sessionTitle(id: string) { return sdkChats.chats.find(chat => chat.id === id && (chat.remoteHost || '') === this.remoteHost)?.title || id.slice(0, 8); }
  private chatLink(id: string) { return html`<a href=${`#chat=${encodeURIComponent(id)}${this.remoteHost ? `&host=${encodeURIComponent(this.remoteHost)}` : ''}`} title=${`Open ${this.sessionTitle(id)}`}>${this.sessionTitle(id)}</a>`; }
  private actor(actor?: WorkActor) { return actor?.kind === 'chat' && actor.sessionId ? this.chatLink(actor.sessionId) : actor?.kind === 'remote-chat' && actor.sessionId ? `Remote chat ${actor.sessionId.slice(0, 8)}` : actor?.kind === 'human' ? 'You' : 'Muxterm'; }
  private date(value: string) { return new Date(value).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'}); }
  private goalReady(item: WorkItem) { return !!item.goalCondition && !!item.goalRevision && (item.goalFiledRevision === item.goalRevision || item.goalApprovedRevision === item.goalRevision); }
  private attention(item: WorkItem) { return (item.status === 'review' && !item.reviewerSessionId) || (item.status === 'blocked' && !!item.needsHuman) || (item.status === 'open' && item.readiness !== 'draft' && !!item.goalCondition && !this.goalReady(item)) || item.dispatch?.state === 'uncertain' || item.dispatch?.state === 'failed'; }
  private status(item: WorkItem) {
    if (item.status === 'done') return 'Finished';
    if (item.status === 'cancelled') return 'Cancelled';
    if (item.status === 'review') return 'Ready for review';
    if (item.status === 'blocked') return item.needsHuman ? 'Needs a decision' : 'Blocked';
    if (item.waitingOn?.length) return 'Waiting for other work';
    if (item.readiness === 'held') return 'On hold';
    if (item.status === 'open' && item.readiness === 'draft') return 'Draft';
    if (item.status === 'open' && (!item.goalCondition || !this.goalReady(item))) return item.goalCondition ? 'Goal needs attention' : 'Needs goal';
    if (item.readiness !== 'ready') return 'Draft';
    if (item.dispatch?.state === 'starting' || item.dispatch?.state === 'preparing') return 'Starting worker';
    if (item.status === 'active' && item.graphIntegrationId && item.goalObservation?.state === 'complete') return 'Awaiting Work evidence';
    if (item.status === 'active' || item.ownerSessionId || item.dispatch) return 'In motion';
    return 'Ready to start';
  }
  private statusIcon(item: WorkItem): 'play' | 'wait' | 'alert' | 'check' | 'clock' | 'flag' {
    if (item.status === 'blocked' || item.dispatch?.state === 'uncertain' || item.dispatch?.state === 'failed') return 'alert';
    if (item.status === 'done' || item.status === 'review') return 'check';
    if (item.waitingOn?.length || item.readiness === 'held') return 'wait';
    if (item.status === 'active' || item.ownerSessionId || item.dispatch) return 'play';
    return item.readiness === 'ready' ? 'flag' : 'clock';
  }
  private kickoffProgress(item: WorkItem) {
    return item.dispatch?.state === 'starting' && item.status === 'open' ? 'Muxterm is checking that the selected chat received the kickoff.' : '';
  }
  private summary(item: WorkItem) {
    return this.kickoffProgress(item) || item.blockedReason || item.nextAction || item.progress || item.brief || 'Open to see the details.';
  }
  private detailKey(item: WorkItem) { return `muxterm:work-detail-tab:${this.remoteHost || 'local'}:${this.projectId || item.projectIds?.[0] || 'all'}:${item.id}`; }
  private defaultTab(item: WorkItem): DetailTab { return item.status === 'active' || item.status === 'blocked' ? 'plan' : item.status === 'review' ? 'activity' : 'description'; }
  private restoreTab(item: WorkItem) {
    const key = this.detailKey(item);
    if (key === this.selectedTabKey) return;
    this.selectedTabKey = key;
    try {
      const saved = localStorage.getItem(key);
      this.selectedTab = detailTabs.some(tab => tab.id === saved) ? saved as DetailTab : this.defaultTab(item);
    } catch { this.selectedTab = this.defaultTab(item); }
  }
  private selectTab(tab: DetailTab) {
    this.selectedTab = tab;
    if (this.selectedTabKey) { try { localStorage.setItem(this.selectedTabKey, tab); } catch { /* Storage may be disabled. */ } }
  }
  private onDetailTabKeydown(event: KeyboardEvent, tab: DetailTab) {
    const index = detailTabs.findIndex(entry => entry.id === tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % detailTabs.length : event.key === 'ArrowLeft' ? (index + detailTabs.length - 1) % detailTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    const nextTab = detailTabs[next].id;
    this.selectTab(nextTab);
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>(`#work-tab-${nextTab}`)?.focus());
  }
  @state() private navigationNotice = '';

  private openDetail(item: WorkItem, notice = '') {
    this.navigationNotice = notice;
    this.error = '';
    if (this.detail?.id !== item.id) {
      this.completionItem = undefined;
      this.commentDraft = '';
      this.commentPriority = 'normal';
      this.commentRef = '';
      this.commentRefBody = '';
      this.ackRef = '';
      this.ackThrough = '';
    }
    this.detail = item;
    this.restoreTab(item);
    this.loadDependencyReferences([...(item.dependsOn || []), ...(item.graphLinks || [])]);
    void this.refresh();
  }
  showWorkItem(id: string, notice?: string) { void this.openDependency(id, notice); }
  private async openDependency(id: string, notice?: string) {
    const found = this.work.find(item => item.id === id);
    if (found) { this.openDetail(found, notice); return; }
    const key = this.refreshKey;
    try {
      const item = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(id)}`);
      if (key === this.refreshKey) this.openDetail(item, notice);
    } catch (error) { if (key === this.refreshKey) this.error = String(error); }
  }
  private loadDependencyReferences(ids: string[]) {
    for (const id of ids) {
      if (this.work.some(item => item.id === id) || this.dependencyReferences[id] || this.loadingDependencies.has(id)) continue;
      this.loadingDependencies.add(id);
      void this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(id)}`).then(item => {
        this.dependencyReferences = {...this.dependencyReferences, [id]:item};
      }).catch(() => {}).finally(() => this.loadingDependencies.delete(id));
    }
  }
  private workLink(id: string) {
    const target = this.work.find(item => item.id === id) || this.dependencyReferences[id];
    const reference = target?.reference || 'Work item';
    const hash = new URLSearchParams({chat:this.sessionId, work:id});
    const sourceHost = chatHost(this.sessionId);
    if (sourceHost) hash.set('host', sourceHost);
    if (this.remoteHost !== sourceHost) hash.set('workHost', this.remoteHost);
    return html`<a class="work-dependency-reference" href=${`#${hash}`} @click=${(event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const link = new CustomEvent('work-reference-open', {
        bubbles:true, composed:true, cancelable:true, detail:{id, host:this.remoteHost, trigger:event.currentTarget},
      });
      if (this.dispatchEvent(link)) void this.openDependency(id);
    }}>${reference}${target ? ` · ${target.title}` : ''}</a>`;
  }
  private graphProgress(item: WorkItem) {
    if (item.graphIntegrationId !== item.id || !item.graphLinks?.length) return nothing;
    const children = item.graphLinks.flatMap(id => {
      const child = this.work.find(row => row.id === id) || this.dependencyReferences[id];
      return child ? [child] : [];
    });
    const completed = children.filter(child => child.status === 'done').length;
    const frontier = children.filter(child => child.status !== 'done' && !child.waitingOn?.length);
    return html`<section class="section"><h3>Epic progress</h3>
      <p>${completed} of ${item.graphLinks.length} prerequisites complete</p>
      ${frontier.length ? html`<ul class="work-links">${frontier.map(child => {
        const recovering = ['starting', 'uncertain'].includes(child.dispatch?.state || '');
        const state = child.status === 'blocked' && child.needsHuman ? 'Decision needed'
          : recovering ? 'Recovering worker'
          : this.status(child);
        return html`<li>${this.workLink(child.id)}<span>${state}</span>
          ${child.blockedReason ? html`<p>${child.blockedReason}</p>` : nothing}</li>`;
      })}</ul>` : nothing}
    </section>`;
  }
  private dependencies(item: WorkItem) {
    const related = (item.graphLinks || []).filter(id => !item.dependsOn?.includes(id) && id !== item.graphIntegrationId);
    const integration = item.graphIntegrationId && item.graphIntegrationId !== item.id ? item.graphIntegrationId : '';
    return html`
      <section class="section"><h3>Prerequisites</h3>
        ${item.dependsOn?.length ? html`<ul class="work-links">${item.dependsOn.map(id => {
          const target = this.work.find(row => row.id === id) || this.dependencyReferences[id];
          const state = item.waitingOn?.includes(id) ? target?.status === 'blocked' ? 'Blocked' : target?.status === 'cancelled' ? 'Cancelled' : 'Awaiting completion' : 'Done';
          return html`<li>${this.workLink(id)}<span>${state}</span></li>`;
        })}</ul>` : html`<p>None</p>`}
      </section>
      ${integration || related.length ? html`<section class="section"><h3>Linked work</h3>
        <ul class="work-links">
          ${integration ? html`<li>${this.workLink(integration)}<span>Integration and release</span></li>` : nothing}
          ${related.map(id => html`<li>${this.workLink(id)}</li>`)}
        </ul>
      </section>` : nothing}
    `;
  }
  private controls() { const control = this.control; return html`<div class="controls"><div class="controls-main"><mux-ui-button class="play" icon-only variant="secondary" ?disabled=${!control} accessible-label=${control?.paused ? 'Continue project work' : 'Pause project work'} title=${control?.paused ? 'Continue project work' : 'Pause project work'} @click=${() => void this.changeControl({paused: !control?.paused})}>${icon(control?.paused ? 'play' : 'pause')}</mux-ui-button><span class="active-count">${control?.active ?? 0} in motion${control?.paused ? ' · paused' : ''}</span></div><div class="parallel"><mux-ui-range-field label="Parallel" accessible-label="Parallel work in this project" .min=${1} .max=${8} .value=${control?.parallelism ?? 4} .valueLabels=${["1 at once", "2 at once", "3 at once", "4 at once", "5 at once", "6 at once", "7 at once", "8 at once"]} ?disabled=${!control} @change=${(event: Event) => void this.changeControl({parallelism: (event.target as MuxUIRangeField).value})}></mux-ui-range-field></div></div>`; }
  private group(title: string, key: string, items: WorkItem[]) {
    if (!items.length) return nothing;
    const open = !this.collapsed[key];
    return html`<section class="group"><mux-ui-button class="group-head" variant="quiet" expandable ?expanded=${open} @click=${() => { this.collapsed = {...this.collapsed, [key]: open}; }}><span class="chevron">${icon('chevron')}</span>${title}<span class="count">${items.length}</span></mux-ui-button>${open ? html`<div class="group-body">${items.map(item => html`<div class="row"><span class=${`kind ${item.status === 'blocked' ? 'blocked' : item.waitingOn?.length ? 'waiting' : key === 'motion' ? 'working' : key === 'ready' ? 'ready' : ''}`}>${icon(this.statusIcon(item))}${this.status(item)}</span><mux-ui-button variant="quiet" accessible-label=${`Open ${item.reference || 'Work item'}: ${item.title}`} @click=${() => this.openDetail(item)}>${item.reference ? html`<span class="work-reference">${item.reference}</span>` : nothing}<strong>${item.title}</strong></mux-ui-button><p>${this.summary(item)}</p>${item.ownerSessionId ? html`<div class="meta">With ${this.chatLink(item.ownerSessionId)}</div>` : nothing}</div>`)}</div>` : nothing}</section>`;
  }
  private list() {
    const labels = [...new Set(this.work.flatMap(item => item.labels || []))].sort();
    const selected = this.work.filter(item => (!this.labelFilter || item.labels?.includes(this.labelFilter)) && (this.filter === 'all' || (this.filter === 'finished' ? item.status === 'done' || item.status === 'cancelled' : item.status !== 'done' && item.status !== 'cancelled')));
    const attention = selected.filter(item => this.attention(item));
    const other = selected.filter(item => !this.attention(item));
    const motion = other.filter(item => item.status === 'active' || (item.status === 'open' && (item.ownerSessionId || item.dispatch)));
    const ready = other.filter(item => item.status === 'open' && item.readiness === 'ready' && this.goalReady(item) && !item.waitingOn?.length && !item.ownerSessionId && !item.dispatch);
    const waiting = other.filter(item => !motion.includes(item) && !ready.includes(item) && item.status !== 'done' && item.status !== 'cancelled');
    const finished = other.filter(item => item.status === 'done' || item.status === 'cancelled');
    return html`<nav class="filters" aria-label="Work filter">${(['open','all','finished'] as const).map(filter => html`<mux-ui-button class="filter" variant="quiet" size="small" ?selected=${this.filter === filter} @click=${() => { this.filter = filter; }}>${filter === 'open' ? 'Open' : filter === 'all' ? 'All' : 'Finished'}</mux-ui-button>`)}${labels.length ? html`<mux-ui-select class="label-filter" size="small" aria-label="Filter by label" .value=${this.labelFilter} .options=${[{value:"",label:"All labels"},...labels.map(label => ({value:label,label}))]} @change=${(event: Event) => { this.labelFilter = (event.target as MuxUISelect).value; }}></mux-ui-select>` : nothing}</nav>${this.controls()}${attention.length ? html`<section class="attention" aria-label="Needs your attention">${attention.map(item => html`<div class="attention-item"><span class=${`kind ${item.status === 'review' ? 'review' : item.status === 'blocked' ? 'blocked' : ''}`}>${icon(this.statusIcon(item))}${this.status(item)}</span><mux-ui-button variant="quiet" accessible-label=${`Open ${item.reference || 'Work item'}: ${item.title}`} @click=${() => this.openDetail(item)}>${item.reference ? html`<span class="work-reference">${item.reference}</span>` : nothing}<h3>${item.title}</h3></mux-ui-button><p>${this.summary(item)}</p></div>`)}</section>` : nothing}${this.group('In motion','motion',motion)}${this.group('Ready to start','ready',ready)}${this.group('Waiting & blocked','waiting',waiting)}${this.group('Finished','finished',finished)}${!selected.length ? html`<div class="empty"><strong>${this.work.length ? 'Nothing in this view' : 'No work here yet'}</strong><p>${this.work.length ? 'Try another filter.' : 'Ask a chat to capture an item for this project.'}</p></div>` : nothing}`;
  }
  @state() private completionItem?: WorkItem;
  @state() private completionError = '';
  @state() private completing = false;

  private async submitCompletion(event: SubmitEvent, item: WorkItem) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const reviewedUnreadComments = form.querySelector('mux-ui-switch')?.checked === true;
    const resolutions = this.remainingSteps(item).map(step => ({
      id: step.id, status: data.get(`status-${step.id}`), reason: data.get(`reason-${step.id}`),
    }));
    const evidence = String(data.get('evidence') ?? '').split('\n').map(line => line.trim()).filter(Boolean);
    await this.completeWork(item, {
      reason: String(data.get('reason') ?? ''), resolutions, evidence, reviewedUnreadComments,
    });
  }

  private async completeWork(item: WorkItem, completion?: {
    reason: string; resolutions: {id:string;status:FormDataEntryValue | null;reason:FormDataEntryValue | null}[];
    evidence: string[]; reviewedUnreadComments: boolean;
  }) {
    if (this.completing) return;
    const details = completion ?? {
      reason: 'Marked complete from Work details.',
      resolutions: this.remainingSteps(item).map(step => ({
        id: step.id, status: 'skipped', reason: 'Closed by a human with this step unfinished.',
      })),
      closedWithoutReview: true,
    };
    this.completing = true;
    this.completionError = '';
    try {
      const updated = await this.request<WorkItem>(`/api/sdk-work/${encodeURIComponent(item.id)}/complete`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({clientRef: crypto.randomUUID(), expectedRevision: item.revision,
          ...details}),
      });
      if (this.detail?.id === item.id) {
        this.detail = updated;
        this.selectTab('activity');
      }
      this.completionItem = undefined;
      void this.refresh();
    } catch (error) {
      if (completion) this.completionError = String(error);
      else this.navigationNotice = String(error);
      void this.refresh();
    } finally {
      this.completing = false;
    }
  }

  private remainingSteps(item: WorkItem) {
    return (item.plan || []).filter(step => step.status !== 'done' && step.status !== 'skipped');
  }

  private completionForm(item: WorkItem) {
    const remaining = this.remainingSteps(item);
    const comments = item.ownerSessionId ? this.unreadComments(item) : [];
    const resolved = (item.plan || []).filter(step => !remaining.includes(step));
    const reports = (item.updates || []).filter(update => update.outcome || update.evidence?.length);
    return html`<form class="completion-form" @submit=${(event: SubmitEvent) => void this.submitCompletion(event, item)}>
      <h3>Mark complete</h3>
      ${item.outcome || reports.length ? html`<section>
        <h4>Previously reported</h4>
        ${item.outcome ? html`<p>${item.outcome}</p>` : nothing}
        <ul>${reports.map(update => html`<li>${this.actor(update.actor)} · ${this.date(update.at)}
          ${update.outcome && update.outcome !== item.outcome ? html`<p>${update.outcome}</p>` : nothing}
          ${update.evidence?.map(reference => html`<p>${reference}</p>`)}
        </li>`)}</ul>
      </section>` : nothing}
      ${resolved.length ? html`<ul aria-label="Previously resolved steps">${resolved.map(step => html`<li>${step.title} · ${step.status === 'done' ? 'Done' : 'Skipped'}</li>`)}</ul>` : nothing}
      ${remaining.map(step => html`<fieldset>
        <legend>${step.title} · ${step.status.replace('_', ' ')}</legend>
        <mux-ui-select label="Resolution" required name=${`status-${step.id}`} .options=${[
          {value:'', label:'Choose a resolution'}, {value:'done', label:'Done'}, {value:'skipped', label:'Skipped'},
        ]}></mux-ui-select>
        <mux-ui-text-field label="Step reason" required name=${`reason-${step.id}`}></mux-ui-text-field>
      </fieldset>`)}
      ${comments.length ? html`<section>
        <h4>Comments unread by the owner</h4>
        <ul>${comments.map(comment => html`<li><strong>${this.actor(comment.actor)}</strong><p>${comment.text}</p></li>`)}</ul>
        <mux-ui-switch layout="row" label="I reviewed these comments" description="They will remain unread for the owner."></mux-ui-switch>
      </section>` : nothing}
      <mux-ui-text-area label="Completion reason" required name="reason" .maxLength=${4096} .rows=${3}></mux-ui-text-area>
      <mux-ui-text-area label=${item.graphId ? 'Verification evidence' : 'New verification evidence (optional)'}
        ?required=${!!item.graphId} name="evidence" .rows=${2} placeholder="One reference per line"></mux-ui-text-area>
      ${this.completionError ? html`<p role="alert">${this.completionError}</p>` : nothing}
      <div class="completion-actions">
        <mux-ui-button variant="quiet" ?disabled=${this.completing} @click=${() => { this.completionItem = undefined; }}>Cancel</mux-ui-button>
        <mux-ui-button variant="primary" ?disabled=${this.completing} @click=${(event: Event) => (event.currentTarget as HTMLElement).closest('form')?.requestSubmit()}>${this.completing ? 'Completing…' : 'Confirm completion'}</mux-ui-button>
      </div>
    </form>`;
  }

  private timelineEntry(update: WorkUpdate, item: WorkItem) {
    if (update.comment) {
      const unread = this.unreadComments(item).some(comment => comment.id === update.id);
      const notice = item.commentNotice?.anchorId === update.id ? item.commentNotice.state : '';
      const boundary = item.commentBoundary?.anchorId === update.id ? item.commentBoundary.state : '';
      const source = update.commentSource === 'side-chat' ? 'via side chat' : update.commentSource === 'chat' ? 'via chat' : update.commentSource === 'work-pane' ? 'in Work' : update.commentSource === 'remote-chat' ? 'via remote chat' : '';
      return html`<li><span class="timeline-icon">${icon('chat')}</span><div><time>${this.date(update.at)}</time><strong>Comment from ${this.actor(update.actor)} ${source}</strong><div class="comment-meta"><span class=${`comment-priority ${update.commentPriority === 'high' ? 'high' : ''}`}>${update.commentPriority === 'high' ? 'High priority' : 'Normal priority'}</span><span>${!item.ownerSessionId ? 'Awaiting owner' : unread ? 'Unread by owner' : 'Read by owner'}</span>${notice ? html`<span>Check-comments steer ${notice}</span>` : nothing}${boundary ? html`<span>${boundary === 'pending' ? 'Notice pending for next owner turn' : 'Next-turn notice sent'}</span>` : nothing}</div><p class="comment-body">${update.text}</p></div></li>`;
    }
    const mark = update.status === 'done' || update.status === 'review' || update.goalApproved ? 'check' : update.status === 'blocked' ? 'alert' : update.status === 'active' ? 'play' : update.readiness === 'ready' ? 'flag' : update.linkedSessionId || update.ownerSessionId ? 'chat' : 'clock';
    const title = update.planAfter ? `Plan revised by ${this.actor(update.actor)}` : update.commentReadThrough ? 'Comments marked read' : update.commentNoticeState === 'next-turn-sent' || update.commentNoticeState === 'routine-sent' ? 'Next-turn comment notice delivered' : update.commentNoticeState ? `Check-comments steer ${update.commentNoticeState}` : update.goalApproved ? 'Goal approved' : update.goalCondition ? 'Goal drafted' : update.status === 'done' ? update.completion ? 'Marked complete by a human' : 'Work completed' : update.status === 'blocked' ? 'Blocked' : update.status === 'review' ? 'Ready for review' : update.status === 'active' ? 'Work started' : update.status ? 'Work updated' : update.readiness === 'ready' ? 'Marked ready' : update.readiness === 'held' ? 'Put on hold' : html`Update from ${this.actor(update.actor)}`;
    const body = update.text || update.progress || update.outcome || update.blockedReason || '';
    const summary = update.summary?.trim() || activityPreview(body);
    const expanded = !!body && !update.completion && (!!update.summary && update.summary.trim() !== body.trim() || body.length > 160 || body.includes('\n'));
    const fallback = update.goalCondition ? 'Condition ready for review.' : update.ownerSessionId ? html`Claimed by ${this.chatLink(update.ownerSessionId)}` : update.linkedSessionId ? html`Linked ${this.chatLink(update.linkedSessionId)}` : update.readiness ? `Readiness: ${update.readiness}` : 'Record updated';
    const evidence = update.evidence?.length ? html`<p class="activity-evidence">${update.completion ? 'New verification evidence' : 'Evidence'}: ${update.evidence.join(', ')}</p>` : nothing;
    const content = expanded
      ? html`<p class="activity-summary">${summary}</p><details class="activity-full"><summary>Read full update</summary><div class="activity-markdown">${renderSegments(parseMarkdown(body))}${evidence}</div></details>`
      : body ? html`<div class="activity-markdown">${renderSegments(parseMarkdown(body))}${evidence}</div>`
        : html`<p class="activity-summary">${summary || fallback}</p>${evidence}`;
    const planChange = update.completion ? html`
      ${update.completion.resolutions?.map(resolution => html`<p>${item.plan?.find(step => step.id === resolution.id)?.title || resolution.id} · ${resolution.status === 'done' ? 'Done' : 'Skipped'}<br>${resolution.reason}</p>`)}
      ${update.completion.reviewedUnreadComments ? html`<p>Human reviewed comments still unread by the owner.</p>` : nothing}
    ` : update.planAfter ? html`<p>Reason: ${update.planReason}</p><p>Before: ${(update.planBefore || []).map(step => `${step.title} (${step.status})`).join(' · ') || 'No plan'}</p><p>After: ${update.planAfter.map(step => `${step.title} (${step.status})`).join(' · ')}</p>` : update.stepUpdates?.length ? html`<p>Steps: ${update.stepUpdates.map(change => `${change.id} → ${change.status.replace('_',' ')}`).join(' · ')}</p>` : nothing;
    return html`<li><span class="timeline-icon">${icon(mark)}</span><div><time>${this.date(update.at)}</time><strong>${title}</strong>${content}${planChange}</div></li>`;
  }
  private detailView() {
    const item = this.detail;
    if (!item) return nothing;
    const planSteps = item.plan || [];
    const countableSteps = planSteps.filter(step => step.status !== 'skipped');
    const doneCount = countableSteps.filter(step => step.status === 'done').length;
    const skippedCount = planSteps.length - countableSteps.length;
    const updates = [...(item.updates || [])].reverse();
    const unreadCount = item.ownerSessionId ? this.unreadComments(item).length : 0;
    const state = this.status(item);
    const stateClass = item.status === 'blocked' ? 'blocked' : item.status === 'done' ? 'done' : item.waitingOn?.length ? 'waiting' : '';
    const move = this.kickoffProgress(item) || item.nextAction || item.blockedReason || '';
    const movePreview = activityPreview(move);
    const inMotion = item.status === 'active' || item.status === 'blocked' || (item.status === 'open' && (!!item.ownerSessionId || !!this.kickoffProgress(item)));
    const tab = this.selectedTab;
    return html`<article class="detail-view">
      ${this.projectId ? html`<mux-ui-button class="back" variant="quiet" size="small" @click=${() => { this.detail = undefined; }}>${icon('back')}Back to work</mux-ui-button>` : nothing}<div class="project detail-project">${icon('folder')}${this.workProjectName(item)}</div>
      <div class=${`status ${stateClass}`}>${icon(this.statusIcon(item))}${state}</div>
      ${item.reference ? html`<span class="work-reference work-reference-detail">${item.reference}</span>${this.remoteHost ? html`<span class="work-reference-host">on ${this.remoteHost}</span>` : nothing}` : nothing}
      <h2>${item.title}</h2>
      ${this.graphProgress(item)}
      ${this.navigationNotice ? html`<p role="status">${this.navigationNotice}</p>` : nothing}
      ${inMotion && move ? html`<div class=${`next-brief ${item.status === 'blocked' ? 'blocked' : ''}`}><strong>${item.status === 'blocked' ? 'What is needed' : 'Next move'}</strong><p>${movePreview}</p>${unreadCount ? html`<mux-ui-button variant="quiet" size="small" @click=${() => this.selectTab('activity')}>Read ${unreadCount} unread ${unreadCount === 1 ? 'comment' : 'comments'}</mux-ui-button>` : nothing}</div>` : nothing}
      ${this.completionItem?.id === item.id && item.status !== 'done' && item.status !== 'cancelled' ? this.completionForm(this.completionItem)
        : item.status !== 'done' && item.status !== 'cancelled' ? html`
          <mux-ui-button variant="secondary" ?disabled=${this.completing || !Array.isArray(item.updates)} @click=${() => {
            this.navigationNotice = '';
            if (item.graphId) {
              this.completionItem = item;
              this.completionError = '';
            } else {
              void this.completeWork(item);
            }
          }}>Mark complete</mux-ui-button>
        ` : nothing}
      <div class="detail-tabs" role="tablist" aria-label="Work item details">
        ${detailTabs.map(entry => html`<mux-ui-button id=${`work-tab-${entry.id}`} class="detail-tab" variant="quiet" control-role="tab" controls="work-detail-panel" ?tab-selected=${tab === entry.id} ?tab-stop=${tab === entry.id} @click=${() => this.selectTab(entry.id)} @keydown=${(event: KeyboardEvent) => this.onDetailTabKeydown(event, entry.id)}>${icon(entry.icon)}<span class="detail-tab-label">${entry.label}</span>${entry.id === 'plan' && planSteps.length ? html`<span class="detail-tab-count" aria-label=${`${planSteps.length} steps`}>${planSteps.length}</span>` : entry.id === 'activity' && (unreadCount || updates.length) ? html`<span class="detail-tab-count" aria-label=${unreadCount ? `${unreadCount} unread comments` : `${updates.length} updates`}>${unreadCount || updates.length}</span>` : nothing}</mux-ui-button>`)}
      </div>
      <div id="work-detail-panel" class="detail-panel" role="tabpanel" aria-labelledby=${`work-tab-${tab}`} tabindex="0">
      ${tab === 'plan' && !this.completionItem && !item.graphId && item.status !== 'done' && item.status !== 'cancelled' ? html`
        <mux-ui-button variant="quiet" size="small" ?disabled=${this.completing || !Array.isArray(item.updates)} @click=${() => {
          this.completionItem = item;
          this.completionError = '';
        }}>Review checklist before closing</mux-ui-button>` : nothing}
      ${tab === 'description' ? html`
        ${item.goalObservation ? html`<p>Last observed chat goal: ${item.goalObservation.state}${item.goalObservation.summary ? html` · ${item.goalObservation.summary}` : nothing}</p>` : nothing}
        ${this.renderWorkChatGoal(item)}
        <mux-work-goal-review .item=${item} .remoteHost=${this.remoteHost} @work-goal-updated=${(event:CustomEvent<WorkItem>) => { this.detail=event.detail; void this.refresh(); }}></mux-work-goal-review>
        ${item.outcome ? html`<section class="section"><h3>Outcome</h3><p>${item.outcome}</p></section>` : nothing}
        ${item.source ? html`<section class="section"><h3>Origin</h3><p>${item.source}</p></section>` : nothing}
      ` : tab === 'people' ? html`
        <section class="section"><h3>Worker agent</h3>${(item.status === 'open' || item.status === 'blocked') && !item.ownerSessionId && (!item.dispatch || item.dispatch.state === 'failed') ? html`<mux-ui-select label="Work harness" .value=${item.harness || ''} .options=${[{value:'',label:'AI default at dispatch'},...workHarnesses.map(harness => ({value:harness,label:harness}))]} ?disabled=${this.harnessSaving} @change=${(event: Event) => void this.changeHarness(item, (event.target as MuxUISelect).value)}></mux-ui-select><p>The selected agent must be available and able to run this Work goal.</p>` : html`<p>${item.harness ? `Selected on item: ${item.harness}` : 'AI default at dispatch'}${item.dispatch?.choiceSource ? ` · source: ${item.dispatch.choiceSource}` : ''}</p>`}</section>
        <section class="section"><h3>People</h3><p><strong>Owner:</strong> ${item.ownerSessionId ? this.chatLink(item.ownerSessionId) : 'Unassigned'}</p><p><strong>Reviewer:</strong> ${item.reviewerSessionId ? this.chatLink(item.reviewerSessionId) : 'None assigned'}</p><p><strong>Created by:</strong> ${this.actor(item.createdBy)}</p>${item.sessionIds?.length ? html`<p><strong>Linked chats:</strong> ${item.sessionIds.map((id, index) => html`${index ? ', ' : ''}${this.chatLink(id)}`)}</p>` : nothing}</section>
        ${this.dependencies(item)}
        ${item.dispatch ? html`<section class="section"><h3>Dispatch</h3><p>${item.dispatch.state === 'starting' ? 'Checking kickoff delivery' : item.dispatch.state}${item.dispatch.sessionId ? html` · ${this.chatLink(item.dispatch.sessionId)}` : nothing}${item.dispatch.choiceSource ? ` · ${item.dispatch.choiceSource}` : ''}</p>${item.dispatch.selectionReason ? html`<p>${item.dispatch.selectionReason}</p>` : nothing}${item.dispatch.configuration ? html`<p>${item.dispatch.configuration.harness} · ${item.dispatch.configuration.provider || 'none'} · bundle ${item.dispatch.configuration.bundle || 'none'} · model ${item.dispatch.configuration.model || 'none'} · effort ${item.dispatch.configuration.effort || 'none'}</p>` : nothing}${item.dispatch.goalMode ? html`<p>Goal control: ${item.dispatch.goalMode === 'muxterm-work' ? 'Muxterm-owned Work goal' : 'Native agent goal'}</p>` : nothing}${item.dispatch.detail ? html`<p>${item.dispatch.detail}</p>` : nothing}</section>` : nothing}
        ${item.labels?.length ? html`<section class="section"><h3>Labels</h3><div class="tags">${item.labels.map(label => html`<span class="tag">${label}</span>`)}</div></section>` : nothing}
      ` : tab === 'plan' ? html`
        ${move && (!inMotion || movePreview !== move) ? html`<section class=${`next ${item.status === 'blocked' ? 'blocked' : ''}`}><h3>${item.status === 'blocked' ? 'What is needed' : 'Next move'}</h3><p>${move}</p></section>` : nothing}
        ${planSteps.length ? html`<section class="plan" aria-labelledby="work-plan-title"><div class="plan-head"><h3 id="work-plan-title">Plan</h3><span class="plan-count">${doneCount} of ${countableSteps.length} steps done${skippedCount ? ` · ${skippedCount} skipped` : ''}${planSteps.some(step => step.status === 'blocked') ? ' · blocked' : ''}</span></div>${countableSteps.length ? html`<progress aria-label="Work plan steps done" .value=${doneCount} .max=${countableSteps.length}></progress>` : nothing}<ol class="plan-list">${planSteps.map(step => html`<li><span class=${`step-state ${step.status}`}>${step.status === 'in_progress' ? 'In progress' : step.status.charAt(0).toUpperCase() + step.status.slice(1)}</span><span class="step-title">${step.title}</span></li>`)}</ol></section>` : html`<section class="section"><h3>Plan</h3><p>No steps filed yet.</p></section>`}
        ${item.progress ? html`<section class="section"><h3>Where things stand</h3><p>${item.progress}</p></section>` : nothing}
        ${item.planProtocol ? html`<section class="section"><h3>Update protocol</h3><p>${item.planProtocol}</p></section>` : nothing}
      ` : html`
        <section class="section"><h3>Recent activity</h3>${unreadCount ? html`<div class="comment-attention"><strong>${unreadCount} unread ${unreadCount === 1 ? 'comment' : 'comments'} for the owner</strong><mux-ui-button variant="secondary" ?disabled=${this.ackSending} @click=${() => void this.acknowledgeComments(item)}>${this.ackSending ? 'Marking…' : 'Mark comments read'}</mux-ui-button></div>` : nothing}<ol class="timeline">${updates.length ? updates.map(update => this.timelineEntry(update, item)) : html`<li><span class="timeline-icon">${icon('work')}</span><div><time>${this.date(item.createdAt)}</time><strong>Added to work</strong><p>${item.source || 'Created for this project.'}</p></div></li>`}</ol><div class="comment-form"><mux-ui-text-area label="Add a comment" .value=${this.commentDraft} .rows=${4} placeholder="Coordinate on this Work item" @input=${(event: Event) => { this.commentDraft = (event.target as MuxUITextArea).value; }}></mux-ui-text-area><div class="comment-priority-field"><span>Delivery</span><mux-ui-select aria-label="Comment delivery priority" .value=${this.commentPriority} .options=${[{value:'normal',label:'Normal · next owner update'}, {value:'high',label:'High · check-comments steer'}]} @change=${(event: Event) => { this.commentPriority = (event.target as MuxUISelect).value as 'normal' | 'high'; }}></mux-ui-select></div><mux-ui-button variant="primary" ?disabled=${!this.commentDraft.trim() || this.commentSending} @click=${() => void this.postComment()}>${this.commentSending ? 'Posting…' : 'Post comment'}</mux-ui-button></div></section>
        <div class="facts"><span>Created ${this.date(item.createdAt)}</span><span>Updated ${this.date(item.updatedAt)}</span></div>
      `}
      </div>
    </article>`;
  }
  @state() private githubRepo = '';
  @state() private githubIssues?: GitHubIncomingIssue[];
  @state() private githubError = '';
  @state() private githubSyncing = false;

  private async syncGitHub() {
    const repo = this.githubRepo.trim();
    if (!/^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/i.test(repo)) {
      this.githubError = 'Enter a GitHub repository as owner/repo.';
      return;
    }
    const key = this.refreshKey;
    this.githubSyncing = true;
    this.githubError = '';
    try {
      const path = repo.split('/').map(encodeURIComponent).join('/');
      const result = await this.request<{issues:GitHubIncomingIssue[] | null}>(`/api/work-github-sync/${path}`, {method:'POST'});
      if (key !== this.refreshKey) return;
      this.githubRepo = repo;
      this.githubIssues = result.issues ?? [];
      localStorage.setItem(`work-github-repo:${this.projectId}`, repo);
    } catch (error) {
      if (key === this.refreshKey) this.githubError = (error as Error).message;
    } finally {
      if (key === this.refreshKey) this.githubSyncing = false;
    }
  }

  private githubInbox() {
    return html`<section class="section" aria-label="Incoming GitHub issues">
      <form @submit=${(event:SubmitEvent) => { event.preventDefault(); void this.syncGitHub(); }}>
        <mux-ui-text-field label="GitHub repository" placeholder="owner/repo" .value=${this.githubRepo}
          ?disabled=${this.githubSyncing} @input=${(event:Event) => {
            this.githubRepo = (event.target as MuxUITextField).value;
            this.githubIssues = undefined;
            this.githubError = '';
          }} @keydown=${(event:KeyboardEvent) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void this.syncGitHub();
          }}></mux-ui-text-field>
        <mux-ui-button type="submit" ?disabled=${this.githubSyncing}
          @click=${(event:Event) => { event.preventDefault(); void this.syncGitHub(); }}>
          ${this.githubSyncing ? 'Syncing…' : this.githubRepo.trim() ? `Sync from ${this.githubRepo.trim()}` : 'Sync issues'}
        </mux-ui-button>
      </form>
      ${this.githubError ? html`<p role="alert">${this.githubError}</p>` : nothing}
      ${this.githubIssues ? html`<h3>Incoming</h3>
        ${this.githubIssues.length ? html`<ul>${this.githubIssues.map(issue => html`<li>
          <a target="_blank" rel="noopener noreferrer" href=${`https://github.com/${this.githubRepo.split('/').map(encodeURIComponent).join('/')}/issues/${issue.number}`}>
            #${issue.number} ${issue.title}
          </a> <small>${issue.assignees.map(a => a.login).join(', ')}</small>
        </li>`)}</ul>` : html`<p>No assigned issues labeled muxterm:work.</p>`}
      ` : nothing}
    </section>`;
  }
  override render() {
    return html`<div class=${this.detail ? 'wrap detail-wrap' : 'wrap'}><div class="top"><div>${this.detail ? nothing : html`<h2>Work</h2><div class="project">${icon('folder')}${this.projectName()}</div>`}</div></div>${!this.projectId && !this.detail ? html`<div class="empty"><strong>Choose a project to see its work.</strong></div>` : this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}${this.detail ? this.detailView() : this.projectId ? html`${!this.remoteHost ? this.githubInbox() : nothing}${this.list()}` : nothing}</div>`;
  }
}
