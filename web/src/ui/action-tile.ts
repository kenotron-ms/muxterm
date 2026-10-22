import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** A described action for tool choosers and empty workspaces. The native
 * button owns focus and keyboard activation; the description adds context
 * without becoming part of the button's short accessible name. */
@customElement('mux-ui-action-tile')
export class MuxUIActionTile extends LitElement {
  @property() label = '';
  @property() description = '';
  @property({ type: Boolean, reflect: true }) disabled = false;

  static override styles = css`
    :host { display:block; min-width:0; font-family:var(--ui-font-sans); }
    button {
      box-sizing:border-box; display:flex; align-items:center; gap:var(--ui-space-5);
      width:100%; min-height:var(--ui-row-touch); padding:var(--ui-space-5) var(--ui-space-6);
      border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg);
      background:var(--ui-surface-raised); color:var(--ui-text); text-align:left; cursor:pointer;
    }
    button:hover:not(:disabled) { border-color:var(--ui-accent); background:var(--ui-surface-hover); }
    button:hover:not(:disabled) .icon { color:var(--ui-accent); }
    button:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    button:disabled { opacity:.5; cursor:default; }
    .icon { display:inline-flex; align-items:center; justify-content:center; flex:none; width:20px; height:20px; color:var(--ui-text-muted); }
    .copy { display:flex; flex-direction:column; gap:var(--ui-space-1); min-width:0; }
    .label { font:600 var(--ui-text-sm)/1.25 var(--ui-font-sans); }
    .description { color:var(--ui-text-muted); font:var(--ui-text-xs)/1.35 var(--ui-font-sans); }
  `;

  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('button')?.focus(options); }
  override click(): void { if (!this.disabled) this.renderRoot.querySelector('button')?.click(); }

  override render() {
    return html`<button type="button" ?disabled=${this.disabled} aria-label=${this.label || nothing}
      aria-describedby=${this.description ? 'description' : nothing}>
      <span class="icon" aria-hidden="true"><slot name="icon"></slot></span>
      <span class="copy"><span class="label">${this.label}</span>${this.description ? html`<span class="description" id="description">${this.description}</span>` : nothing}</span>
    </button>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-action-tile': MuxUIActionTile } }
