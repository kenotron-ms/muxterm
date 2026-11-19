import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import '../ui/button.js';

export type WorkGoalReviewItem = { id:string; title:string; revision:number; status:string; readiness?:string; ownerSessionId?:string; dispatch?:unknown; goalCondition?:string; goalRevision?:number; goalApprovedRevision?:number };

@customElement('mux-work-goal-review')
export class MuxWorkGoalReview extends LitElement {
  @property({attribute:false}) item?: WorkGoalReviewItem;
  @property() workId = '';
  @property() remoteHost = '';
  @state() private current?: WorkGoalReviewItem;
  @state() private pending = false;
  @state() private error = '';

  static styles = css`
    :host { display:block; }
    * { box-sizing:border-box; }
    .review { padding:var(--ui-space-7) var(--ui-space-8); border-radius:var(--ui-radius-xl); background:var(--ui-surface-raised); color:var(--ui-text); font:var(--ui-text-lg)/1.55 var(--ui-font-sans); }
    h3,p { margin:0; }
    h3 { margin-bottom:var(--ui-space-4); font-size:var(--ui-text-md); }
    .condition { white-space:pre-wrap; overflow-wrap:anywhere; }
    .note { margin-top:var(--ui-space-4); color:var(--ui-text-muted); font-size:var(--ui-text-md); }
    .actions { display:flex; flex-wrap:wrap; gap:var(--ui-space-4); margin-top:var(--ui-space-6); }
    .error { margin-top:var(--ui-space-4); color:var(--ui-danger); }
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
  private async submit(ready:boolean, approve:boolean) {
    const item=this.current;
    if (!item || this.pending || !item.goalCondition) return;
    this.pending=true;
    try {
      const path=approve ? `/api/sdk-work/${encodeURIComponent(item.id)}/goal/approve` : `/api/sdk-work/${encodeURIComponent(item.id)}/updates`;
      const body=approve ? {clientRef:crypto.randomUUID(),expectedRevision:item.revision,goalRevision:item.goalRevision,condition:item.goalCondition,ready} : {clientRef:crypto.randomUUID(),expectedRevision:item.revision,readiness:'ready',text:'Ready for the scheduler'};
      const response=await fetch(this.path(path),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if (!response.ok) throw Error((await response.text()).trim());
      this.current=await response.json() as WorkGoalReviewItem;
      this.error='';
      this.dispatchEvent(new CustomEvent('work-goal-updated',{detail:this.current,bubbles:true,composed:true}));
    } catch (error) { this.error=String(error); }
    finally { this.pending=false; }
  }
  override render() {
    const item=this.current || this.item;
    if (!item) return this.error ? html`<p class="error" role="alert">${this.error} <mux-ui-button variant="secondary" @click=${() => void this.refresh()}>Refresh</mux-ui-button></p>` : nothing;
    const approved=!!item.goalCondition && item.goalRevision === item.goalApprovedRevision;
    const canAct=item.status === 'open' && item.readiness !== 'ready' && !item.dispatch && !item.ownerSessionId;
    return html`<section class="review" aria-label=${`Goal review for ${item.title}`}><h3>Goal for the worker</h3>
      ${item.goalCondition ? html`<p class="condition">${item.goalCondition}</p>
        ${approved ? html`<p class="note">Approved by you. ${item.status !== 'open' ? 'This is the condition given to the worker.' : item.readiness === 'ready' ? 'Waiting for the scheduler.' : 'Start when you are ready.'}</p>${canAct ? html`<div class="actions"><mux-ui-button variant="primary" ?disabled=${this.pending} @click=${() => void this.submit(true,false)}>Start work</mux-ui-button></div>` : nothing}`
          : html`<p class="note">Review this exact condition. Ask a chat to revise it if the outcome or stopping point needs work.</p>${canAct ? html`<div class="actions"><mux-ui-button variant="primary" ?disabled=${this.pending} @click=${() => void this.submit(true,true)}>Approve & start</mux-ui-button><mux-ui-button variant="secondary" ?disabled=${this.pending} @click=${() => void this.submit(false,true)}>Approve only</mux-ui-button></div>` : nothing}`}
      ` : html`<p class="note">Ask a chat to draft a clear stopping condition for this item. You can review it here before starting work.</p>`}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p><div class="actions"><mux-ui-button variant="secondary" @click=${() => void this.refresh()}>Refresh</mux-ui-button></div>` : nothing}
    </section>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-work-goal-review': MuxWorkGoalReview } }
