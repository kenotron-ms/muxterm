import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** One action in mux-ui-menu. Links retain native navigation and download behavior. */
@customElement('mux-ui-menu-item')
export class MuxUIMenuItem extends LitElement {
  @property() href = '';
  @property() download = '';
  @property() target = '';
  @property() rel = '';
  @property({ reflect: true }) tone: 'default' | 'danger' = 'default';
  @property({ type: Boolean, reflect: true }) disabled = false;

  static override styles = css`
    :host { display: block; color: var(--ui-text); font: var(--ui-text-sm)/1.4 var(--ui-font-sans); }
    :host([tone='danger']) { color: var(--ui-danger); }
    button, a {
      box-sizing: border-box; display: flex; align-items: center; gap: var(--ui-space-4);
      width: 100%; min-height: var(--ui-control-md); padding: var(--ui-space-3) var(--ui-space-4);
      border: 0; border-radius: var(--ui-radius-sm); background: transparent; color: inherit;
      font: inherit; text-align: left; text-decoration: none; cursor: pointer;
    }
    button:hover:not(:disabled), a:hover { background: var(--ui-surface-hover); }
    button:focus-visible, a:focus-visible { background: var(--ui-surface-hover); outline: 2px solid var(--ui-focus); outline-offset: -2px; }
    button:disabled, a[aria-disabled='true'] { opacity: .5; cursor: default; }
    @media (max-width: 700px), (pointer: coarse) { button, a { min-height: var(--ui-control-lg); } }
  `;

  override focus(options?: FocusOptions): void {
    const control = this.renderRoot.querySelector<HTMLElement>('button, a');
    if (control) control.focus(options);
    else void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('button, a')?.focus(options));
  }

  override click(): void {
    if (this.disabled) return;
    const control = this.renderRoot.querySelector<HTMLElement>('button, a');
    if (control) control.click();
    else void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('button, a')?.click());
  }

  override render() {
    const content = html`<slot></slot>`;
    return this.href
      ? html`<a role="menuitem" href=${this.disabled ? nothing : this.href} download=${this.download || nothing}
          target=${this.target || nothing} rel=${this.rel || nothing} aria-disabled=${this.disabled ? 'true' : nothing}>${content}</a>`
      : html`<button type="button" role="menuitem" ?disabled=${this.disabled}>${content}</button>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-menu-item': MuxUIMenuItem } }
