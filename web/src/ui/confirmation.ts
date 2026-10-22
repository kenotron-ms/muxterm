import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { MuxUIDialog } from './dialog.js';
import type { MuxUIButton } from './button.js';
import './dialog.js';
import './button.js';

/** An adaptive confirmation surface. The owner performs the action and closes it. */
@customElement('mux-ui-confirmation')
export class MuxUIConfirmation extends LitElement {
  @property({ type:Boolean }) open = false;
  @property({ type:Boolean }) busy = false;
  @property() heading = '';
  @property() description = '';
  @property() confirmLabel = 'Confirm';
  @property() cancelLabel = 'Cancel';
  @property() tone: 'danger' | 'primary' = 'danger';

  static override styles = css`
    :host { display: contents; }
    .content {
      box-sizing: border-box;
      display: grid;
      gap: var(--ui-space-6);
      width: 100%;
      padding: var(--ui-space-8);
      color: var(--ui-text);
      font: var(--ui-text-md)/1.5 var(--ui-font-sans);
    }
    h2 { margin: 0; font-size: var(--ui-text-xl); line-height: 1.3; }
    p { margin: 0; color: var(--ui-text-muted); }
    .actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--ui-space-3); margin-top: var(--ui-space-2); }
    mux-ui-button { min-width: var(--ui-space-16); }
    @media (max-width: 700px) {
      .content { padding: var(--ui-space-7) var(--ui-space-6) calc(var(--ui-space-7) + env(safe-area-inset-bottom)); }
    }
  `;

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (!this.open || !changed.has('open')) return;
    const dialog = this.renderRoot.querySelector<MuxUIDialog>('mux-ui-dialog');
    void dialog?.updateComplete.then(() => requestAnimationFrame(() => this.focusCancel()));
  }

  focusCancel(): void {
    if (this.busy) return;
    this.renderRoot.querySelector<MuxUIButton>('.cancel')?.focus({ preventScroll:true });
  }

  private cancel(): void {
    if (this.busy) return;
    this.open = false;
    this.dispatchEvent(new CustomEvent('confirmation-cancel', { bubbles:true, composed:true }));
  }

  private confirm(): void {
    if (this.busy) return;
    this.busy = true;
    const dialog = this.renderRoot.querySelector<MuxUIDialog>('mux-ui-dialog');
    if (dialog) dialog.dismissable = false;
    this.dispatchEvent(new CustomEvent('confirmation-confirm', { bubbles:true, composed:true }));
  }

  override render() {
    return html`<mux-ui-dialog .open=${this.open} .dismissable=${!this.busy} size="compact" presentation="adaptive"
        .label=${this.heading || 'Confirm action'} .description=${this.description} @dismiss=${this.cancel}>
      <div class="content">
        <h2>${this.heading}</h2>
        <p>${this.description}</p>
        <div class="actions">
          <mux-ui-button class="cancel" ?disabled=${this.busy} @click=${this.cancel}>${this.cancelLabel}</mux-ui-button>
          <mux-ui-button variant=${this.tone} ?busy=${this.busy} @click=${this.confirm}>${this.confirmLabel}</mux-ui-button>
        </div>
      </div>
    </mux-ui-dialog>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-confirmation': MuxUIConfirmation } }
