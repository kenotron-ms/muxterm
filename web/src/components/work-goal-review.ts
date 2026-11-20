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
export type WorkGoalReviewItem = { id:string; title:string; brief?:string; acceptanceCriteria?:string; labels?:string[]; uiWork?:boolean; createdBy?:{kind:string;sessionId?:string}; revision:number; status:string; readiness?:string; ownerSessionId?:string; dispatch?:unknown; reviewVersion?:number; designPreview?:DesignPreview; goalCondition?:string; goalRevision?:number; goalFiledRevision?:number; goalApprovedRevision?:number; goalCheck?:GoalCheck; updates?:GoalDraft[] };

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
    .sheet { display:grid; gap:var(--ui-space-6); min-width:0; }
    .panel { min-width:0; border:1px solid var(--ui-border); border-radius:var(--ui-radius-xl); background:var(--ui-surface-raised); padding:var(--ui-space-8); }
    .head { display:flex; align-items:start; justify-content:space-between; flex-wrap:wrap; gap:var(--ui-space-5); margin-bottom:var(--ui-space-5); }
    h3 { font-size:var(--ui-text-lg); letter-spacing:-.01em; line-height:1.35; }
    h4 { font-size:var(--ui-text-md); }
    .muted,.meta { color:var(--ui-text-muted); }
    .meta { font-size:var(--ui-text-sm); }
    .copy { max-width:75ch; overflow-wrap:anywhere; }
    .copy > :first-child { margin-top:0; }
    .copy .md-p { margin:0 0 var(--ui-space-5); }
    .copy .md-h { margin:var(--ui-space-7) 0 var(--ui-space-4); color:var(--ui-accent); font-size:var(--ui-text-md); }
    .copy .md-ul,.copy .md-ol { margin:var(--ui-space-5) 0 var(--ui-space-6); padding-left:var(--ui-space-7); }
    .copy .md-li + .md-li { margin-top:var(--ui-space-3); }
    .copy .md-li .md-p { margin:0; }
    .copy .md-code { padding:var(--ui-space-px) var(--ui-space-2); border-radius:var(--ui-radius-sm); background:var(--ui-surface-base); font-family:var(--ui-font-mono); }
    .copy .md-pre,.raw { max-width:100%; overflow:auto; padding:var(--ui-space-6); border-radius:var(--ui-radius-md); background:var(--ui-surface-base); font:var(--ui-text-sm)/1.5 var(--ui-font-mono); white-space:pre-wrap; overflow-wrap:anywhere; }
    .copy .md-tablewrap { max-width:100%; overflow:auto; }
    .copy .md-quote { margin:var(--ui-space-5) 0; padding-left:var(--ui-space-5); border-left:2px solid var(--ui-border); }
    .brief { font-size:var(--ui-text-lg); }
    .criteria { margin-top:var(--ui-space-6); padding-top:var(--ui-space-6); border-top:1px solid var(--ui-border); }
    .criteria h4 { margin-bottom:var(--ui-space-3); }
    .preview-grid { display:grid; grid-template-columns:minmax(0,1.7fr) minmax(160px,1fr); gap:var(--ui-space-5); }
    .preview { display:block; min-width:0; overflow:hidden; border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); color:var(--ui-text); text-decoration:none; }
    .preview span { display:block; padding:var(--ui-space-3) var(--ui-space-5); background:var(--ui-surface-hover); font-size:var(--ui-text-sm); }
    .preview img { display:block; width:100%; aspect-ratio:16/9; object-fit:cover; object-position:top; background:var(--ui-surface-base); }
    .preview.phone img { aspect-ratio:9/12; }
    .preview-link { display:inline-block; margin-top:var(--ui-space-5); color:var(--ui-accent); text-underline-offset:3px; overflow-wrap:anywhere; }
    .missing { padding:var(--ui-space-6); border:1px solid var(--ui-warning); border-radius:var(--ui-radius-md); color:var(--ui-text); background:color-mix(in srgb,var(--ui-warning) 9%,var(--ui-surface-raised)); }
    .goal-check { min-width:0; margin-top:var(--ui-space-6); padding-top:var(--ui-space-6); border-top:1px solid var(--ui-border); }
    .goal-check .head { margin-bottom:var(--ui-space-4); }
    .goal-check .verdict { display:inline-block; max-width:100%; overflow-wrap:anywhere; }
    .goal-check > .muted { margin-top:var(--ui-space-4); }
    .goal-source { padding-top:var(--ui-space-6); border-top:1px solid var(--ui-border); margin-top:var(--ui-space-6); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:var(--ui-space-4); }
    .goal-source mux-ui-button::part(button) { min-height:0; padding:0; }
    .history { margin-top:var(--ui-space-6); padding-top:var(--ui-space-5); border-top:1px solid var(--ui-border); }
    .history summary { cursor:pointer; color:var(--ui-text-muted); }
    .history-item { padding:var(--ui-space-5) 0; border-top:1px solid var(--ui-border); }
    .history-item:first-of-type { margin-top:var(--ui-space-5); }
    .history-item pre { white-space:pre-wrap; overflow-wrap:anywhere; font:var(--ui-text-sm)/1.5 var(--ui-font-mono); }
    .verdict { border-radius:var(--ui-radius-md); padding:var(--ui-space-5); font-weight:700; }
    .verdict.pass { color:var(--ui-success); background:color-mix(in srgb,var(--ui-success) 13%,var(--ui-surface-raised)); }
    .verdict.pending { color:var(--ui-warning); background:color-mix(in srgb,var(--ui-warning) 11%,var(--ui-surface-raised)); }
    .verdict.fail { color:var(--ui-danger); background:color-mix(in srgb,var(--ui-danger) 9%,var(--ui-surface-raised)); }
    .findings { margin-top:var(--ui-space-5); padding-left:var(--ui-space-6); }
    .findings li + li { margin-top:var(--ui-space-5); }
    .findings strong { display:block; }
    .findings q { display:block; margin:var(--ui-space-2) 0; color:var(--ui-text-muted); overflow-wrap:anywhere; }
    .check-action { margin-top:var(--ui-space-6); }
    .decision { display:flex; justify-content:space-between; align-items:center; gap:var(--ui-space-6); }
    .decision p { color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
    .actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:var(--ui-space-4); }
    .actions a { align-self:center; color:var(--ui-accent); }
    .error { padding:var(--ui-space-5); color:var(--ui-danger); overflow-wrap:anywhere; }
    :focus-visible { outline:2px solid var(--ui-accent); outline-offset:2px; }
    @media(max-width:560px) { .sheet { gap:var(--ui-space-5); } .panel { padding:var(--ui-space-6); } .preview-grid { grid-template-columns:1fr; } .preview.phone img { aspect-ratio:9/10; } .decision { align-items:stretch; flex-direction:column; } .actions { justify-content:stretch; } .actions mux-ui-button { flex:1 1 auto; } }
    @media(max-width:350px) { .panel { padding:var(--ui-space-6); } .actions { flex-direction:column; } }
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
  private async file() {
    const item=this.current;
    if (!item?.goalCondition || this.pending || (item.reviewVersion && (!item.goalCheck?.passed || item.goalCheck.goalRevision !== item.goalRevision))) return;
    await this.post(`/api/sdk-work/${encodeURIComponent(item.id)}/updates`,{clientRef:crypto.randomUUID(),expectedRevision:item.revision,readiness:'ready',text:'Ready for the scheduler'});
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
    const authorized=!!item.goalCondition && !!item.goalRevision && (item.goalRevision === item.goalFiledRevision || item.goalRevision === item.goalApprovedRevision);
    const filed=authorized && item.readiness === 'ready';
    const held=item.readiness === 'held';
    const canAct=item.status === 'open' && item.readiness === 'draft' && !item.dispatch && !item.ownerSessionId;
    const checked=!!item.goalCheck && item.goalCheck.goalRevision === item.goalRevision;
    const passed=!item.reviewVersion || checked && !!item.goalCheck?.passed;
    const previewReady=this.previewReady(item);
    const drafts=(item.updates || []).filter(update => !!update.goalCondition && update.goalRevision !== item.goalRevision).reverse();
    const preview=item.designPreview;
    const changeLink=item.createdBy?.sessionId ? `#chat=${encodeURIComponent(item.createdBy.sessionId)}${this.remoteHost ? `&host=${encodeURIComponent(this.remoteHost)}` : ''}` : '';
    return html`<div class="sheet" aria-label=${`Work review for ${item.title}`}>
      <section class="panel" aria-labelledby="brief-heading"><div class="head"><h3 id="brief-heading">What will change</h3><span class="meta">Work brief</span></div><div class="copy brief">${this.markdown(item.brief || 'No brief yet.')}</div>${item.acceptanceCriteria ? html`<div class="criteria"><h4>How we will know it worked</h4><div class="copy">${this.markdown(item.acceptanceCriteria)}</div></div>` : nothing}</section>
      ${this.previewRequired(item) || preview ? html`<section class="panel" aria-labelledby="preview-heading"><div class="head"><h3 id="preview-heading">Proposed experience</h3><span class="meta">${preview ? `Design ${preview.version}` : 'Design in progress'}</span></div>
        ${!preview ? html`<p class="muted">A design preview can be attached as this Work progresses.</p>` : previewReady ? html`<div class="preview-grid">${preview.desktopImageUrl ? html`<a class="preview" href=${preview.desktopImageUrl} target="_blank" rel="noopener noreferrer"><span>Desktop preview</span><img src=${preview.desktopImageUrl} alt="Proposed desktop experience" loading="lazy"></a>` : nothing}${preview.phoneImageUrl ? html`<a class="preview phone" href=${preview.phoneImageUrl} target="_blank" rel="noopener noreferrer"><span>Phone preview</span><img src=${preview.phoneImageUrl} alt="Proposed phone experience" loading="lazy"></a>` : nothing}</div><a class="preview-link" href=${preview.artifactUrl} target="_blank" rel="noopener noreferrer">Open full design</a>` : html`<p class="missing" role="status">The attached design preview needs a valid artifact link and screenshots for each affected screen.</p>`}
      </section>` : nothing}
      <section class="panel" aria-labelledby="goal-heading"><div class="head"><div><h3 id="goal-heading">Exact goal for the worker</h3><p class="muted">${filed ? 'This checked goal was filed for automatic scheduling.' : `Current stored revision ${item.goalRevision || 0}.`}</p></div><span class="meta">Current revision ${item.goalRevision || 0}</span></div>
        ${item.goalCondition ? html`${this.raw ? html`<pre class="raw">${item.goalCondition}</pre>` : html`<div class="copy">${this.markdown(item.goalCondition)}</div>`}<div class="goal-source"><span class="meta">${filed ? 'The worker receives this exact condition.' : 'Changes create a new revision.'}</span><mux-ui-button variant="quiet" size="small" @click=${() => {this.raw=!this.raw;}}>${this.raw ? 'Show formatted goal' : 'Show raw text'}</mux-ui-button></div>` : html`<p class="muted">Ask the creating chat to draft a clear stopping condition.</p>`}
        ${drafts.length ? html`<details class="history"><summary>Previous goal drafts (${drafts.length})</summary>${drafts.map(draft => html`<div class="history-item"><strong>Revision ${draft.goalRevision}</strong><pre>${draft.goalCondition}</pre></div>`)}</details>` : nothing}
        <section class="goal-check" aria-labelledby="check-heading"><div class="head"><h3 id="check-heading">Goal check</h3></div>
        ${!item.goalCondition ? html`<div class="verdict pending">Waiting for a goal draft</div>` : !item.reviewVersion ? html`<div class="verdict pending">Legacy Work · review the goal manually</div>` : !checked ? html`<div class="verdict pending" role="status">Check pending for revision ${item.goalRevision}</div>` : item.goalCheck?.passed ? html`<div class="verdict pass" role="status">${filed ? 'Checked and filed' : 'Ready to file'} · revision ${item.goalRevision}</div>` : html`<div class="verdict fail" role="status">Changes needed · revision ${item.goalRevision}</div>`}
        ${checked && item.goalCheck?.findings?.length ? html`<ul class="findings">${item.goalCheck.findings.map(finding => html`<li><strong>${finding.rule}: ${finding.message}</strong>${finding.quote ? html`<q>${finding.quote}</q>` : nothing}<span>${finding.suggestion}</span></li>`)}</ul>` : checked && item.goalCheck?.passed ? html`<p class="muted">No known goalify failure pattern found.</p>` : nothing}
        ${item.reviewVersion && canAct && item.goalCondition && !checked ? html`<div class="check-action"><mux-ui-button variant="secondary" ?disabled=${this.pending} @click=${() => void this.check()}>Check this revision</mux-ui-button></div>` : nothing}
        </section>
      </section>
      <section class="panel decision" aria-label="Work filing status"><div><h3>${filed ? 'Filed for work' : held ? 'On hold' : 'Draft'}</h3><p>${filed ? 'Muxterm will schedule this item when project capacity and dependencies allow.' : held ? 'A human hold is keeping this item out of the scheduler.' : !passed ? 'Resolve the goal check findings before filing.' : 'File this checked goal to let Muxterm schedule the work.'}</p></div>${canAct ? html`<div class="actions">${changeLink ? html`<a href=${changeLink}>Ask for changes</a>` : nothing}<mux-ui-button variant="primary" ?disabled=${this.pending || !passed} @click=${() => void this.file()}>File and schedule</mux-ui-button></div>` : nothing}</section>
      ${this.error ? html`<p class="error" role="alert">${this.error} <mux-ui-button variant="secondary" @click=${() => void this.refresh()}>Refresh</mux-ui-button></p>` : nothing}
    </div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-work-goal-review': MuxWorkGoalReview } }
