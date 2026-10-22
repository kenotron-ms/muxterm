import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { MuxUIDialog } from '../ui/dialog.js';
import type { MuxUITextField } from '../ui/text-field.js';
import '../ui/dialog.js';
import '../ui/text-field.js';
import '../ui/button.js';

/** Workspace creation UI. The app owns the sessiond request and result. */
@customElement('mux-workspace-create-dialog')
export class MuxWorkspaceCreateDialog extends LitElement {
  @property({ type:Boolean }) open = false;
  @property({ type:Boolean }) busy = false;
  @state() private name = '';

  static styles = css`
    :host { display:contents; }
    .content { box-sizing:border-box; display:grid; gap:var(--ui-space-6); width:100%; padding:var(--ui-space-7); color:var(--ui-text); font:var(--ui-text-md)/1.4 var(--ui-font-sans); }
    h2 { margin:0; font-size:var(--ui-text-xl); line-height:1.3; }
    .actions { display:flex; justify-content:flex-end; gap:var(--ui-space-3); }
    @media(max-width:700px) { .content { padding:var(--ui-space-6) var(--ui-space-6) calc(var(--ui-space-6) + env(safe-area-inset-bottom)); } }
  `;

  override updated(changed: Map<PropertyKey,unknown>): void {
    if (!this.open || !changed.has('open')) return;
    void this.renderRoot.querySelector<MuxUIDialog>('mux-ui-dialog')?.updateComplete.then(() => {
      this.renderRoot.querySelector<MuxUITextField>('mux-ui-text-field')?.focus();
    });
  }
  private cancel(): void {
    if (this.busy) return;
    this.dispatchEvent(new CustomEvent('workspace-create-cancel',{bubbles:true,composed:true}));
  }
  private submit(): void {
    const field = this.renderRoot.querySelector<MuxUITextField>('mux-ui-text-field');
    const name = (field?.liveValue ?? this.name).trim();
    if (!name || this.busy) return;
    this.dispatchEvent(new CustomEvent('workspace-create-submit',{detail:{name},bubbles:true,composed:true}));
  }
  private onNameKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    this.submit();
  }
  override render() {
    return html`<mux-ui-dialog .open=${this.open} .dismissable=${!this.busy} size="compact" presentation="adaptive" label="New workspace" @dismiss=${this.cancel}>
      <div class="content">
        <h2>New workspace</h2>
        <mux-ui-text-field aria-label="Workspace name" placeholder="Workspace name" .value=${this.name} ?disabled=${this.busy}
          @input=${(event:Event) => { this.name=(event.target as MuxUITextField).value; }} @keydown=${this.onNameKeyDown}></mux-ui-text-field>
        <div class="actions">
          <mux-ui-button variant="quiet" ?disabled=${this.busy} @click=${this.cancel}>Cancel</mux-ui-button>
          <mux-ui-button variant="primary" ?busy=${this.busy} ?disabled=${!this.name.trim()} @click=${this.submit}>${this.busy ? 'Creating…' : 'Create'}</mux-ui-button>
        </div>
      </div>
    </mux-ui-dialog>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-workspace-create-dialog': MuxWorkspaceCreateDialog } }
