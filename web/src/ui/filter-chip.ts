import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** A compact, countable filter with native button keyboard and pressed semantics. */
@customElement('mux-ui-filter-chip')
export class MuxUIFilterChip extends LitElement {
  @property({ type:Boolean, reflect:true }) pressed = false;
  @property({ type:Boolean, reflect:true }) disabled = false;
  @property({ type:Number }) count = -1;

  static override styles = css`
    :host { display:inline-flex; font-family:var(--ui-font-sans); }
    button {
      box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center;
      gap:var(--ui-space-3); min-height:var(--ui-control-sm);
      padding:var(--ui-space-2) var(--ui-space-5);
      border:1px solid var(--ui-border); border-radius:var(--ui-radius-pill);
      background:var(--ui-surface-raised); color:var(--ui-text-muted);
      font:600 var(--ui-text-sm)/1.25 var(--ui-font-sans);
      white-space:nowrap; cursor:pointer;
    }
    button:hover:not(:disabled) { border-color:var(--ui-border-strong); color:var(--ui-text); }
    button:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    :host([pressed]) button {
      border-color:color-mix(in srgb,var(--ui-accent) 60%,var(--ui-border));
      background:var(--ui-nav-selected); color:var(--ui-text);
    }
    button:disabled { opacity:.5; cursor:default; }
    .count { color:var(--ui-text-muted); font-variant-numeric:tabular-nums; }
    :host([pressed]) .count { color:var(--ui-accent); }
    @media(pointer:coarse) { button { min-height:var(--ui-control-lg); } }
  `;

  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('button')?.focus(options); }
  override click(): void { if (!this.disabled) this.renderRoot.querySelector('button')?.click(); }

  override render() {
    return html`<button type="button" aria-pressed=${String(this.pressed)} ?disabled=${this.disabled}>
      <slot></slot>${this.count >= 0 ? html`<span class="count">${this.count}</span>` : nothing}
    </button>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-filter-chip': MuxUIFilterChip } }
