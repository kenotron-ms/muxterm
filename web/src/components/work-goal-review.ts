import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import { parseMarkdown } from '../lib/markdown-stream.js';
import { renderSegments } from '../lib/markdown-view.js';
import '../ui/button.js';

type DesignPreview = { version:string; artifactUrl:string; desktopImageUrl?:string; phoneImageUrl?:string; affectsDesktop?:boolean; affectsPhone?:boolean };
type GoalFinding = { rule:string; quote?:string; message:string; suggestion:string };
type GoalCheck = { goalRevision:number; passed:boolean; findings:GoalFinding[]; checkedAt:string };
type GoalDraft = { goalCondition?:string; goalRevision?:number; at:string };
export type WorkGoalReviewItem = { id:string; title:string; brief?:string; acceptanceCriteria?:string; labels?:string[]; uiWork?:boolean; createdBy?:{kind:string;sessionId?:string}; revision:number; status:string; readiness?:string; ownerSessionId?:string; dispatch?:unknown; reviewVersion?:number; designPreview?:DesignPreview; goalCondition?:string; goalRevision?:number; goalApprovedRevision?:number; goalCheck?:GoalCheck; updates?:GoalDraft[] };

@customElement('mux-work-goal-review')
export class MuxWorkGoalReview extends LitElement {
  @property({attribute:false}) item?: WorkGoalReviewItem;
  @property() workId = '';
  @property() remoteHost = '';
  @state() private current?: WorkGoalReviewItem;
  @state() private pending = false;
  @state() private raw = false;
  @state() private error = '';

  static styles = css`
    :host { display:block; min-width:0; color:var(--ui-text); font:var(--ui-text-md)/1.58 var(--ui-font-sans); }
    * { box-sizing:border-box; }
    h3,h4,p,ul { margin:0; }
    .sheet { display:grid; gap:18px; min-width:0; }
    .panel { min-width:0; border:1px solid var(--ui-border); border-radius:var(--ui-radius-xl); background:var(--ui-surface-raised); padding:24px; }
    .head { display:flex; align-items:start; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:13px; }
    h3 { font-size:var(--ui-text-lg); letter-spacing:-.01em; line-height:1.35; }
    h4 { font-size:var(--ui-text-md); }
    .muted,.meta { color:var(--ui-text-muted); }
    .meta { font-size:var(--ui-text-sm); }
    .copy { max-width:75ch; overflow-wrap:anywhere; }
    .copy > :first-child { margin-top:0; }
    .copy .md-p { margin:0 0 12px; }
    .copy .md-h { margin:20px 0 8px; color:var(--ui-accent); font-size:var(--ui-text-md); }
    .copy .md-ul,.copy .md-ol { margin:10px 0 16px; padding-left:22px; }
    .copy .md-li + .md-li { margin-top:5px; }
    .copy .md-li .md-p { margin:0; }
    .copy .md-code { padding:1px 4px; border-radius:3px; background:var(--ui-surface-base); font-family:var(--ui-font-mono); }
    .copy .md-pre,.raw { max-width:100%; overflow:auto; padding:14px; border-radius:var(--ui-radius-md); background:var(--ui-surface-base); font:var(--ui-text-sm)/1.5 var(--ui-font-mono); white-space:pre-wrap; overflow-wrap:anywhere; }
    .copy .md-tablewrap { max-width:100%; overflow:auto; }
    .copy .md-quote { margin:12px 0; padding-left:12px; border-left:2px solid var(--ui-border); }
    .brief { font-size:var(--ui-text-lg); }
    .criteria { margin-top:16px; padding-top:16px; border-top:1px solid var(--ui-border); }
    .criteria h4 { margin-bottom:6px; }
    .preview-grid { display:grid; grid-template-columns:minmax(0,1.7fr) minmax(160px,1fr); gap:12px; }
    .preview { display:block; min-width:0; overflow:hidden; border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); color:var(--ui-text); text-decoration:none; }
    .preview span { display:block; padding:5px 10px; background:var(--ui-surface-hover); font-size:var(--ui-text-sm); }
    .preview img { display:block; width:100%; aspect-ratio:16/9; object-fit:cover; object-position:top; background:var(--ui-surface-base); }
    .preview.phone img { aspect-ratio:9/12; }
    .preview-link { display:inline-block; margin-top:12px; color:var(--ui-accent); text-underline-offset:3px; overflow-wrap:anywhere; }
    .missing { padding:14px; border:1px solid var(--ui-warning); border-radius:var(--ui-radius-md); color:var(--ui-text); background:color-mix(in srgb,var(--ui-warning) 9%,var(--ui-surface-raised)); }
    .review-grid { display:grid; grid-template-columns:minmax(0,1.8fr) minmax(220px,1fr); align-items:start; gap:18px; }
    .goal-source { padding-top:14px; border-top:1px solid var(--ui-border); margin-top:16px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; }
    .goal-source mux-ui-button::part(button) { min-height:0; padding:0; }
    .history { margin-top:14px; padding-top:12px; border-top:1px solid var(--ui-border); }
    .history summary { cursor:pointer; color:var(--ui-text-muted); }
    .history-item { padding:10px 0; border-top:1px solid var(--ui-border); }
    .history-item:first-of-type { margin-top:10px; }
    .history-item pre { white-space:pre-wrap; overflow-wrap:anywhere; font:var(--ui-text-sm)/1.5 var(--ui-font-mono); }
    .verdict { border-radius:var(--ui-radius-md); padding:11px 12px; font-weight:700; }
    .verdict.pass { color:var(--ui-success); background:color-mix(in srgb,var(--ui-success) 13%,var(--ui-surface-raised)); }
    .verdict.pending { color:var(--ui-warning); background:color-mix(in srgb,var(--ui-warning) 11%,var(--ui-surface-raised)); }
    .verdict.fail { color:var(--ui-danger); background:color-mix(in srgb,var(--ui-danger) 9%,var(--ui-surface-raised)); }
    .findings { margin-top:12px; padding-left:18px; }
    .findings li + li { margin-top:12px; }
    .findings strong { display:block; }
    .findings q { display:block; margin:4px 0; color:var(--ui-text-muted); overflow-wrap:anywhere; }
    .check-action { margin-top:14px; }
    .decision { display:flex; justify-content:space-between; align-items:center; gap:16px; }
    .decision p { color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
    .actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
    .actions a { align-self:center; color:var(--ui-accent); }
    .error { padding:12px; color:var(--ui-danger); overflow-wrap:anywhere; }
    :focus-visible { outline:2px solid var(--ui-accent); outline-offset:2px; }
    @media(max-width:760px) { .review-grid { grid-template-columns:1fr; } }
    @media(max-width:560px) { .sheet { gap:12px; } .panel { padding:18px; } .preview-grid { grid-template-columns:1fr; } .preview.phone img { aspect-ratio:9/10; } .decision { align-items:stretch; flex-direction:column; } .actions { justify-content:stretch; } .actions mux-ui-button { flex:1 1 auto; } }
    @media(max-width:350px) { .panel { padding:14px; } .actions { flex-direction:column; } }
  `;

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has('item') && this.item) this.current = this.item;
    if (changed.has('workId') && this.workId && !this.item) void this.refresh();
  }
  private path(path:string) { return apiPath(remoteChatPath(this.remoteHost,path)); }
  private async refresh() {
    if (!this.workId) return;
    try {
      const response=await fetch(this.path(`/api/sdk-work/${encodeURIComponent(this.workId)}`),{cache:'no-store'});
      if (!response.ok) throw Error((await response.text()).trim());
      this.current=await response.json() as WorkGoalReviewItem;
      this.error='';
    } catch (error) { this.error=String(error); }
  }
  private async post(path:string, body:object) {
    this.pending=true;
    try {
      const response=await fetch(this.path(path),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if (!response.ok) throw Error((await response.text()).trim());
      this.current=await response.json() as WorkGoalReviewItem;
      this.error='';
      this.dispatchEvent(new CustomEvent('work-goal-updated',{detail:this.current,bubbles:true,composed:true}));
    } catch (error) { this.error=String(error); }
    finally { this.pending=false; }
  }
  private async check() {
    const item=this.current;
    if (!item?.goalCondition || this.pending) return;
    await this.post(`/api/sdk-work/${encodeURIComponent(item.id)}/goal/check`,{clientRef:crypto.randomUUID(),expectedRevision:item.revision,goalRevision:item.goalRevision,condition:item.goalCondition});
  }
  private async submit(ready:boolean, approve:boolean) {
    const item=this.current;
    if (!item?.goalCondition || this.pending) return;
    const path=approve ? `/api/sdk-work/${encodeURIComponent(item.id)}/goal/approve` : `/api/sdk-work/${encodeURIComponent(item.id)}/updates`;
    const body=approve ? {clientRef:crypto.randomUUID(),expectedRevision:item.revision,goalRevision:item.goalRevision,condition:item.goalCondition,ready} : {clientRef:crypto.randomUUID(),expectedRevision:item.revision,readiness:'ready',text:'Ready for the scheduler'};
    await this.post(path,body);
  }
  private markdown(text:string) { return renderSegments(parseMarkdown(text)); }
  private previewRequired(item:WorkGoalReviewItem) { return !!item.reviewVersion && (!!item.uiWork || !!item.labels?.some(label => ['ui','ux','frontend','visual-design','web-ui','mobile-ui'].includes(label))); }
  private previewReady(item:WorkGoalReviewItem) {
    if (!this.previewRequired(item)) return true;
    const p=item.designPreview;
    if (!p?.version || !p.artifactUrl) return false;
    return (!p.affectsDesktop && !p.affectsPhone && !!p.desktopImageUrl && !!p.phoneImageUrl) ||
      (!!(p.affectsDesktop || p.affectsPhone) && (!p.affectsDesktop || !!p.desktopImageUrl) && (!p.affectsPhone || !!p.phoneImageUrl));
  }
  override render() {
    const item=this.current || this.item;
    if (!item) return this.error ? html`<p class="error" role="alert">${this.error} <mux-ui-button variant="secondary" @click=${() => void this.refresh()}>Refresh</mux-ui-button></p>` : nothing;
    const approved=!!item.goalCondition && item.goalRevision === item.goalApprovedRevision;
    const canAct=item.status === 'open' && item.readiness !== 'ready' && !item.dispatch && !item.ownerSessionId;
    const checked=!!item.goalCheck && item.goalCheck.goalRevision === item.goalRevision;
    const passed=!item.reviewVersion || checked && !!item.goalCheck?.passed;
    const previewReady=this.previewReady(item);
    const drafts=(item.updates || []).filter(update => !!update.goalCondition && update.goalRevision !== item.goalRevision).reverse();
    const preview=item.designPreview;
    const changeLink=item.createdBy?.sessionId ? `#chat=${encodeURIComponent(item.createdBy.sessionId)}${this.remoteHost ? `&host=${encodeURIComponent(this.remoteHost)}` : ''}` : '';
    return html`<div class="sheet" aria-label=${`Work review for ${item.title}`}>
      <section class="panel" aria-labelledby="brief-heading"><div class="head"><h3 id="brief-heading">What will change</h3><span class="meta">Work brief</span></div><div class="copy brief">${this.markdown(item.brief || 'No brief yet.')}</div>${item.acceptanceCriteria ? html`<div class="criteria"><h4>How we will know it worked</h4><div class="copy">${this.markdown(item.acceptanceCriteria)}</div></div>` : nothing}</section>
      ${this.previewRequired(item) || preview ? html`<section class="panel" aria-labelledby="preview-heading"><div class="head"><h3 id="preview-heading">Proposed experience</h3><span class="meta">${preview ? `Design ${preview.version}` : 'Preview needed'}</span></div>
        ${previewReady && preview ? html`<div class="preview-grid">${preview.desktopImageUrl ? html`<a class="preview" href=${preview.desktopImageUrl} target="_blank" rel="noopener noreferrer"><span>Desktop preview</span><img src=${preview.desktopImageUrl} alt="Proposed desktop experience" loading="lazy"></a>` : nothing}${preview.phoneImageUrl ? html`<a class="preview phone" href=${preview.phoneImageUrl} target="_blank" rel="noopener noreferrer"><span>Phone preview</span><img src=${preview.phoneImageUrl} alt="Proposed phone experience" loading="lazy"></a>` : nothing}</div><a class="preview-link" href=${preview.artifactUrl} target="_blank" rel="noopener noreferrer">Open full design</a>` : html`<p class="missing" role="status">Attach a versioned design link and screenshots for each affected screen before approving this UI Work.${preview ? ' Update the preview with the missing screen.' : ''}</p>`}
      </section>` : nothing}
      <div class="review-grid"><section class="panel" aria-labelledby="goal-heading"><div class="head"><div><h3 id="goal-heading">Exact goal for the worker</h3><p class="muted">Approval uses this stored text, revision ${item.goalRevision || 0}.</p></div><span class="meta">Current revision ${item.goalRevision || 0}</span></div>
        ${item.goalCondition ? html`${this.raw ? html`<pre class="raw">${item.goalCondition}</pre>` : html`<div class="copy">${this.markdown(item.goalCondition)}</div>`}<div class="goal-source"><span class="meta">Editing creates a new approval request.</span><mux-ui-button variant="quiet" size="small" @click=${() => {this.raw=!this.raw;}}>${this.raw ? 'Show formatted goal' : 'Show raw text'}</mux-ui-button></div>` : html`<p class="muted">Ask the creating chat to draft a clear stopping condition.</p>`}
        ${drafts.length ? html`<details class="history"><summary>Previous goal drafts (${drafts.length})</summary>${drafts.map(draft => html`<div class="history-item"><strong>Revision ${draft.goalRevision}</strong><pre>${draft.goalCondition}</pre></div>`)}</details>` : nothing}
      </section>
      <section class="panel" aria-labelledby="check-heading"><div class="head"><h3 id="check-heading">Goal check</h3></div>
        ${!item.goalCondition ? html`<div class="verdict pending">Waiting for a goal draft</div>` : !item.reviewVersion ? html`<div class="verdict pending">Legacy Work · review the goal manually</div>` : !checked ? html`<div class="verdict pending" role="status">Check pending for revision ${item.goalRevision}</div>` : item.goalCheck?.passed ? html`<div class="verdict pass" role="status">Ready to approve · revision ${item.goalRevision}</div>` : html`<div class="verdict fail" role="status">Changes needed · revision ${item.goalRevision}</div>`}
        ${checked && item.goalCheck?.findings?.length ? html`<ul class="findings">${item.goalCheck.findings.map(finding => html`<li><strong>${finding.rule}: ${finding.message}</strong>${finding.quote ? html`<q>${finding.quote}</q>` : nothing}<span>${finding.suggestion}</span></li>`)}</ul>` : checked && item.goalCheck?.passed ? html`<p class="muted">No known goalify failure pattern found. Review the exact condition for meaning and scope before deciding.</p>` : nothing}
        ${item.reviewVersion && canAct && item.goalCondition && !checked ? html`<div class="check-action"><mux-ui-button variant="secondary" ?disabled=${this.pending} @click=${() => void this.check()}>Check this revision</mux-ui-button></div>` : nothing}
      </section></div>
      <section class="panel decision" aria-label="Your decision"><div><h3>Your decision</h3><p>${approved ? 'This exact revision is approved.' : !passed ? 'Run the check and resolve its findings before approval.' : !previewReady ? 'Attach the required design preview before approval.' : 'Review the exact revision, then approve it or ask for changes.'}</p></div>${canAct ? html`<div class="actions">${changeLink ? html`<a href=${changeLink}>Ask for changes</a>` : nothing}${approved ? html`<mux-ui-button variant="primary" ?disabled=${this.pending} @click=${() => void this.submit(true,false)}>Start work</mux-ui-button>` : html`<mux-ui-button variant="secondary" ?disabled=${this.pending || !passed || !previewReady} @click=${() => void this.submit(false,true)}>Approve only</mux-ui-button><mux-ui-button variant="primary" ?disabled=${this.pending || !passed || !previewReady} @click=${() => void this.submit(true,true)}>Approve ${item.goalRevision} and start</mux-ui-button>`}</div>` : nothing}</section>
      ${this.error ? html`<p class="error" role="alert">${this.error} <mux-ui-button variant="secondary" @click=${() => void this.refresh()}>Refresh</mux-ui-button></p>` : nothing}
    </div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-work-goal-review': MuxWorkGoalReview } }
