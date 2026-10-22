import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** A labelled on/off control. The inner button owns switch keyboard semantics. */
@customElement('mux-ui-switch')
export class MuxUISwitch extends LitElement {
  @property({ type:Boolean, reflect:true }) checked = false;
  @property({ type:Boolean, reflect:true }) disabled = false;
  @property({ reflect:true }) layout: 'inline' | 'row' = 'inline';
  @property() label = '';
  @property() description = '';
  @property({ attribute:'accessible-label' }) accessibleLabel = '';
  @property() tooltip = '';

  static override styles = css`
    :host { display:inline-flex; min-width:0; font-family:var(--ui-font-sans); }
    :host([layout='row']) { display:block; width:100%; }
    button {
      box-sizing:border-box; display:inline-flex; align-items:center; justify-content:space-between;
      gap:var(--ui-space-4); min-height:var(--ui-control-md); max-width:100%;
      padding:0 var(--ui-space-2) 0 var(--ui-space-4);
      border:1px solid transparent; border-radius:var(--ui-radius-md);
      background:transparent; color:var(--ui-text-muted);
      font:var(--ui-text-sm)/1.35 var(--ui-font-sans); text-align:left; cursor:pointer;
    }
    :host([layout='row']) button { width:100%; padding:var(--ui-space-4); }
    button:hover:not(:disabled) { background:var(--ui-surface-hover); color:var(--ui-text); }
    button:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    button:disabled { opacity:.5; cursor:default; }
    :host([checked]) button { color:var(--ui-text); }
    .copy { display:grid; gap:var(--ui-space-1); min-width:0; }
    .label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    :host([layout='row']) .label { font-weight:600; }
    .description { color:var(--ui-text-muted); font-size:var(--ui-text-xs); }
    .track {
      box-sizing:border-box; display:flex; align-items:center; flex:none;
      width:var(--ui-switch-track-width); height:var(--ui-switch-track-height);
      padding:var(--ui-space-1); border:1px solid var(--ui-border);
      border-radius:var(--ui-radius-pill); background:var(--ui-surface-base);
      transition:background-color var(--ui-motion-fast) ease,border-color var(--ui-motion-fast) ease;
    }
    .thumb {
      width:var(--ui-switch-thumb-size); height:var(--ui-switch-thumb-size); flex:none;
      border-radius:50%; background:var(--ui-text-muted);
      transition:transform var(--ui-motion-fast) ease;
    }
    :host([checked]) .track { border-color:var(--ui-accent); background:var(--ui-accent); }
    :host([checked]) .thumb { transform:translateX(var(--ui-switch-thumb-travel)); background:var(--ui-on-accent); }
    @media(pointer:coarse) { button { min-height:var(--ui-control-lg); } }
    @media(prefers-reduced-motion:reduce) { .track,.thumb { transition:none; } }
  `;

  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('button')?.focus(options); }
  override click(): void { if (!this.disabled) this.renderRoot.querySelector('button')?.click(); }

  private toggle(): void {
    if (this.disabled) return;
    this.checked = !this.checked;
    this.dispatchEvent(new CustomEvent('change', { detail:{checked:this.checked}, bubbles:true, composed:true }));
  }

  override render() {
    return html`<button type="button" role="switch" aria-checked=${String(this.checked)}
      aria-label=${this.accessibleLabel || this.label || nothing} aria-describedby=${this.description ? 'description' : nothing}
      title=${this.tooltip || nothing} ?disabled=${this.disabled} @click=${this.toggle}>
      <span class="copy"><span class="label">${this.label}</span>${this.description ? html`<span class="description" id="description">${this.description}</span>` : nothing}</span>
      <span class="track" aria-hidden="true"><span class="thumb"></span></span>
    </button>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-switch': MuxUISwitch } }
