import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'small' | 'medium' | 'large';

/** Action button. It owns its visual and interaction states; the inner native
 * button retains keyboard, focus, and disabled semantics. Icon-only buttons
 * need an accessible-label for that native button. Form submit controls should
 * use a native submit button until the field/form layer is introduced. */
@customElement('mux-ui-button')
export class MuxUIButton extends LitElement {
  @property({ reflect: true }) variant: ButtonVariant = 'secondary';
  @property({ reflect: true }) size: ButtonSize = 'medium';
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ type: Boolean, reflect: true }) busy = false;
  @property({ type: Boolean, reflect: true, attribute: 'full-width' }) fullWidth = false;
  @property({ type: Boolean, reflect: true, attribute: 'icon-only' }) iconOnly = false;
  @property({ attribute: 'accessible-label' }) accessibleLabel = '';
  @property({ reflect: true }) tone: 'default' | 'muted' = 'default';
  @property() haspopup = '';
  @property({ type: Boolean }) expanded = false;
  @property() tooltip = '';
  @property() keyshortcuts = '';

  static override styles = css`
    :host { display: inline-flex; vertical-align: middle; font-family: var(--ui-font-sans); }
    :host([full-width]) { display: flex; width: 100%; }
    :host([icon-only]) { width: var(--ui-control-md); height: var(--ui-control-md); }
    :host([icon-only][size='small']) { width: var(--ui-control-sm); height: var(--ui-control-sm); }
    :host([icon-only][size='large']) { width: var(--ui-control-lg); height: var(--ui-control-lg); }
    button {
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--ui-space-4);
      width: 100%;
      min-height: var(--ui-control-md);
      padding: 0 var(--ui-space-5);
      border: 1px solid var(--ui-border);
      border-radius: var(--ui-radius-md);
      background: transparent;
      color: var(--ui-text);
      font: 600 var(--ui-text-md)/1.25 var(--ui-font-sans);
      white-space: nowrap;
      cursor: pointer;
      transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    :host([size='small']) button { min-height: var(--ui-control-sm); padding: 0 var(--ui-space-4); font-size: var(--ui-text-sm); }
    :host([size='large']) button { min-height: var(--ui-control-lg); padding: 0 var(--ui-space-6); font-size: var(--ui-text-lg); }
    :host([icon-only]) button { min-height: 100%; padding: 0; border-radius: var(--ui-radius-lg); }
    :host([variant='primary']) button { border-color: var(--ui-accent); background: var(--ui-accent); color: var(--ui-on-accent); }
    :host([variant='danger']) button { border-color: var(--ui-danger); background: var(--ui-danger); color: var(--ui-on-danger); }
    :host([variant='quiet']) button { border-color: transparent; }
    :host([tone='muted']) button { color: var(--ui-text-muted); }
    :host([tone='muted']) button:hover:not(:disabled) { color: var(--ui-text); }
    button:hover:not(:disabled) { background: var(--ui-surface-hover); }
    :host([variant='primary']) button:hover:not(:disabled) { filter: brightness(1.1); background: var(--ui-accent); }
    :host([variant='danger']) button:hover:not(:disabled) { filter: brightness(1.1); background: var(--ui-danger); }
    button:active:not(:disabled) { transform: translateY(1px); }
    button:focus-visible { outline: 2px solid var(--ui-focus); outline-offset: 2px; }
    button:disabled { cursor: default; opacity: 0.5; filter: none; }
    .spinner {
      width: 1em;
      height: 1em;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: spin 650ms linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (pointer: coarse) {
      button { min-height: var(--ui-control-lg); }
      :host([icon-only]),:host([icon-only][size='small']) { width: var(--ui-control-lg); height: var(--ui-control-lg); }
    }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } .spinner { animation-duration: 1.5s; } }
  `;

  override focus(options?: FocusOptions): void {
    this.renderRoot.querySelector('button')?.focus(options);
  }

  override click(): void {
    if (!this.disabled && !this.busy) this.renderRoot.querySelector('button')?.click();
  }

  override render() {
    return html`<button part="button" type="button" ?disabled=${this.disabled || this.busy}
      title=${this.tooltip || nothing}
      aria-label=${this.accessibleLabel || nothing} aria-keyshortcuts=${this.keyshortcuts || nothing} aria-busy=${String(this.busy)}
      aria-haspopup=${this.haspopup || nothing} aria-expanded=${this.haspopup ? String(this.expanded) : nothing}>
      ${this.busy ? html`<span class="spinner" aria-hidden="true"></span>` : html`<slot name="leading"></slot>`}
      <slot></slot><slot name="trailing"></slot>
    </button>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'mux-ui-button': MuxUIButton }
}
