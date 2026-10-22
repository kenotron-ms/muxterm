import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type DialogSize = 'standard' | 'compact';
export type DialogPresentation = 'centered' | 'adaptive';

/** A modal shell for content owned by a feature. Native dialog provides the
 * top layer, focus containment, and Escape behavior. The feature supplies an
 * accessible label and closes itself when `dismiss` is emitted. */
@customElement('mux-ui-dialog')
export class MuxUIDialog extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ reflect: true }) size: DialogSize = 'standard';
  @property({ reflect: true }) presentation: DialogPresentation = 'centered';
  @property() label = '';
  @property() description = '';
  @property({ type:Boolean }) dismissable = true;

  static override styles = css`
    :host { display: contents; }
    dialog {
      box-sizing: border-box;
      margin: auto;
      padding: 0;
      width: min(var(--ui-dialog-width), calc(100vw - var(--ui-space-9)));
      height: min(80dvh, var(--ui-dialog-height));
      border: 1px solid var(--ui-border);
      border-radius: var(--ui-radius-lg);
      background: var(--ui-surface-overlay);
      background-image: var(--ui-overlay-backdrop-image);
      color: var(--ui-text);
      box-shadow: var(--ui-shadow-overlay);
      overflow: hidden;
    }
    dialog[open] { display: flex; flex-direction: column; }
    dialog:not([open]) { display: none; }
    dialog:focus-visible { outline: 2px solid var(--ui-focus); outline-offset: 2px; }
    .a11y-description { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
    dialog::backdrop {
      background: var(--ui-backdrop);
      background-image: var(--ui-app-backdrop-image);
    }
    :host([size='compact']) dialog {
      width: min(var(--ui-dialog-compact-width), calc(100vw - var(--ui-space-9)));
      height: fit-content;
      max-height: min(80dvh, var(--ui-dialog-compact-max-height));
    }
    :host([size='compact']) dialog[open] { display: block; }
    @media (max-width: 700px) {
      :host([presentation='adaptive']) dialog {
        width: 100vw;
        max-width: none;
        max-height: calc(100dvh - env(safe-area-inset-top) - var(--ui-space-8));
        height: fit-content;
        margin: auto 0 0;
        border-radius: var(--ui-radius-lg) var(--ui-radius-lg) 0 0;
        border-bottom: 0;
        box-shadow: var(--ui-shadow-sheet);
      }
      :host([presentation='adaptive']) dialog::before {
        content: '';
        display: block;
        width: var(--ui-control-md);
        height: var(--ui-space-2);
        margin: var(--ui-space-3) auto 0;
        border-radius: var(--ui-radius-pill);
        background: var(--ui-border);
      }
      :host([presentation='adaptive'][size='compact']) dialog {
        width: 100vw;
        max-height: calc(100dvh - env(safe-area-inset-top) - var(--ui-space-8));
      }
    }
    ::slotted(*) { min-height: 0; }
  `;

  protected override updated(): void {
    const dialog = this._dialog;
    if (!dialog) return;
    if (this.open && !dialog.open) dialog.showModal();
    if (!this.open && dialog.open) dialog.close();
  }

  override disconnectedCallback(): void {
    if (this._dialog?.open) this._dialog.close();
    super.disconnectedCallback();
  }

  private get _dialog(): HTMLDialogElement | null {
    return this.renderRoot.querySelector('dialog');
  }

  private _dismiss(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent('dismiss', { bubbles: true, composed: true }));
  }

  private _onCancel(event: Event): void {
    event.preventDefault();
    if (this.dismissable) this._dismiss();
  }

  private _onClick(event: MouseEvent): void {
    if (this.dismissable && event.target === this._dialog) this._dismiss();
  }

  override render() {
    return html`<dialog aria-modal="true" aria-label=${this.label || nothing} aria-describedby=${this.description ? 'dialog-desc' : nothing} @cancel=${this._onCancel} @click=${this._onClick}>
      ${this.description ? html`<span id="dialog-desc" class="a11y-description">${this.description}</span>` : nothing}
      <slot></slot>
    </dialog>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'mux-ui-dialog': MuxUIDialog }
}
