import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

export type FeedbackKind = 'empty' | 'loading' | 'info' | 'success' | 'warning' | 'error';
export type FeedbackAppearance = 'plain' | 'panel';
export type FeedbackDensity = 'regular' | 'compact';
export type FeedbackLayout = 'stacked' | 'inline';

/** A consistent place for empty, loading, success, and error messages. */
@customElement('mux-ui-feedback')
export class MuxUIFeedback extends LitElement {
  @property({ reflect: true }) kind: FeedbackKind = 'empty';
  @property({ reflect: true }) appearance: FeedbackAppearance = 'plain';
  @property({ reflect: true }) density: FeedbackDensity = 'regular';
  @property({ reflect: true }) layout: FeedbackLayout = 'stacked';
  @property({ reflect: true }) align: 'start' | 'center' = 'start';
  @state() private hasAction = false;

  static override styles = css`
    :host {
      --feedback-tone: var(--ui-text-muted);
      box-sizing: border-box;
      display: block;
      min-width: 0;
      padding: var(--ui-space-7);
      color: var(--ui-text-muted);
      font: var(--ui-text-md)/1.5 var(--ui-font-sans);
    }
    :host([kind='info']) { --feedback-tone: var(--ui-accent); }
    :host([kind='success']) { --feedback-tone: var(--ui-success); color: var(--ui-text); }
    :host([kind='warning']) { --feedback-tone: var(--ui-warning); color: var(--ui-text); }
    :host([kind='error']) { --feedback-tone: var(--ui-danger); color: var(--ui-text); }
    :host([appearance='panel']) {
      border: 1px solid color-mix(in srgb, var(--feedback-tone) 30%, var(--ui-border));
      border-radius: var(--ui-radius-lg);
      background: color-mix(in srgb, var(--feedback-tone) 6%, var(--ui-surface-raised));
    }
    :host([density='compact']) { padding:var(--ui-space-4) var(--ui-space-5); font-size:var(--ui-text-xs); line-height:1.4; }
    :host([density='compact']) .content { gap:var(--ui-space-3); }
    :host([align='center']) { text-align: center; }
    .content { display: flex; align-items: flex-start; gap: var(--ui-space-4); }
    :host([align='center']) .content { justify-content: center; }
    .message { min-width: 0; }
    .spinner {
      display: none;
      flex: none;
      width: 1em;
      height: 1em;
      margin-top: var(--ui-space-1);
      border: 2px solid var(--feedback-tone);
      border-right-color: transparent;
      border-radius: 50%;
      animation: spin 650ms linear infinite;
    }
    :host([kind='loading']) .spinner { display: block; }
    .action { margin-top: var(--ui-space-5); }
    :host([layout='inline']) { container-type:inline-size; }
    :host([layout='inline']) .body { display:flex; align-items:center; gap:var(--ui-space-5); }
    :host([layout='inline']) .content { flex:1; min-width:0; }
    :host([layout='inline']) .message { overflow-wrap:anywhere; }
    :host([layout='inline']) .action { flex:none; margin-top:0; }
    @container (max-width: 380px) {
      :host([layout='inline']) .body { flex-direction:column; align-items:stretch; }
      :host([layout='inline']) .action { align-self:flex-end; }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 1.5s; } }
  `;

  private onActionSlotChange(event: Event): void {
    this.hasAction = (event.target as HTMLSlotElement).assignedElements({ flatten: true }).length > 0;
  }

  override render() {
    const role = this.kind === 'error' || this.kind === 'warning' ? 'alert' : this.kind === 'success' || this.kind === 'loading' ? 'status' : nothing;
    return html`<div class="body" role=${role} aria-busy=${this.kind === 'loading' ? 'true' : nothing}>
      <div class="content"><span class="spinner" aria-hidden="true"></span><div class="message"><slot></slot></div></div>
      <div class="action" ?hidden=${!this.hasAction}><slot name="action" @slotchange=${this.onActionSlotChange}></slot></div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'mux-ui-feedback': MuxUIFeedback }
}
