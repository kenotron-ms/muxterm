import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MuxUIButton } from '../ui/button.js';
import type { MuxUIDialog } from '../ui/dialog.js';
import '../ui/dialog.js';
import type {
  CloseConfirmationRequiredOutcome,
  CloseRiskReason,
} from '../types.js';

const REASON_LABELS: Record<CloseRiskReason, string> = {
  'command-active': 'A command is active',
  'foreground-process': 'A foreground process is active',
  'custom-command': 'This pane uses a custom command',
  'unsupported-shell': 'This shell is not supported for activity detection',
  'unsupported-platform': 'Activity detection is not supported on this platform',
  'missing-lifecycle': 'Shell activity information is unavailable',
  'stale-lifecycle': 'Shell activity information is out of date',
  'process-inspection-failed': 'Process activity could not be inspected',
  'pty-inspection-failed': 'Terminal activity could not be inspected',
  'conflicting-evidence': 'Activity signals conflict',
};

@customElement('close-confirmation-modal')
export class CloseConfirmationModal extends LitElement {
  static styles = css`
    ${subtleScrollbars}
    :host { display: contents; }
    .content {
      box-sizing: border-box;
      overflow: auto;
      max-height: min(78dvh, var(--ui-dialog-compact-max-height));
      padding: var(--ui-space-8);
      color: var(--ui-text);
      font: var(--ui-text-lg)/1.5 var(--ui-font-sans);
    }

    h2 {
      margin: 0 0 var(--ui-space-6);
      font-size: var(--ui-text-xl);
      line-height: 1.3;
    }

    .description {
      color: var(--ui-text-muted);
    }

    .description p {
      margin: var(--ui-space-4) 0;
    }

    .risks {
      margin: var(--ui-space-6) 0 0;
      padding: 0;
      list-style: none;
      border: 1px solid var(--ui-border);
      border-radius: var(--ui-radius-md);
      overflow: hidden;
    }

    .risks li {
      display: flex;
      flex-direction: column;
      gap: var(--ui-space-2);
      padding: var(--ui-space-5);
      border-bottom: 1px solid var(--ui-border);
    }

    .risks li:last-child {
      border-bottom: none;
    }

    .risk-title {
      overflow: hidden;
      color: var(--ui-text);
      font-size: var(--ui-text-md);
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .risk-reason,
    .omitted {
      color: var(--ui-text-muted);
      font-size: var(--ui-text-sm);
      line-height: 1.4;
    }

    .risk-classification {
      color: var(--ui-danger);
      font-weight: 600;
    }

    .omitted {
      margin: var(--ui-space-5) 0 0;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--ui-space-5);
      margin-top: var(--ui-space-7);
    }

    mux-ui-button { min-width: var(--ui-space-16); }
    @media (max-width: 700px) {
      .content { max-height: calc(100dvh - var(--ui-space-8)); padding: var(--ui-space-7) var(--ui-space-6) calc(var(--ui-space-7) + env(safe-area-inset-bottom)); }
    }
  `;

  @property({ attribute: false })
  outcome: CloseConfirmationRequiredOutcome | null = null;

  @property({ type: Boolean })
  confirming = false;

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    const dialog = this._dialog;
    if (!this.outcome || !dialog) return;
    if (changed.has('outcome')) {
      requestAnimationFrame(() => this.focusCancel());
    }
  }

  /** Focuses the safe default action for duplicate intents and refreshed tickets. */
  focusCancel(): void {
    if (this.confirming) return;
    this.shadowRoot
      ?.querySelector<MuxUIButton>('.cancel')
      ?.focus({ preventScroll: true });
  }

  private get _dialog(): MuxUIDialog | null {
    return this.shadowRoot?.querySelector('mux-ui-dialog') ?? null;
  }

  private _emitCancel(): void {
    if (this.confirming) return;
    if (this._dialog) this._dialog.open = false;
    this.dispatchEvent(
      new CustomEvent('close-confirmation-cancel', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return;
    const focused = this.shadowRoot?.activeElement;
    if (!(focused instanceof HTMLButtonElement) && !(focused instanceof MuxUIButton)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private _onConfirm(): void {
    if (!this.outcome || this.confirming) return;
    // Close every dismissal path synchronously, before the parent can re-render
    // the controlled property or the daemon can answer the confirmation.
    this.confirming = true;
    if (this._dialog) this._dialog.dismissable = false;
    this.dispatchEvent(
      new CustomEvent<{ ticket: string }>('close-confirmation-confirm', {
        detail: { ticket: this.outcome.ticket },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const outcome = this.outcome;
    if (!outcome) return html``;

    const noun = outcome.targetKind === 'pane' ? 'pane' : 'workspace';
    const title = outcome.targetKind === 'pane' ? 'Close pane?' : 'Close workspace?';
    const confirmLabel = outcome.targetKind === 'pane' ? 'Close Pane' : 'Close Workspace';
    const busyDescription = `Running work will terminate if you close this ${noun}.`;
    const unknownDescription = `Activity cannot be determined and work may terminate if you close this ${noun}.`;
    const description = [
      outcome.busyCount > 0 ? busyDescription : '',
      outcome.unknownCount > 0 ? unknownDescription : '',
    ].filter(Boolean).join(' ');

    return html`
      <mux-ui-dialog
        open size="compact" presentation="adaptive"
        .label="${title}"
        .description="${description}"
        .dismissable="${!this.confirming}"
        @dismiss="${this._emitCancel}"
        @keydown="${this._onKeyDown}"
      >
        <div class="content">
        <h2>${title}</h2>
        <div class="description">
          ${outcome.busyCount > 0
            ? html`<p>${busyDescription}</p>`
            : ''}
          ${outcome.unknownCount > 0
            ? html`<p>${unknownDescription}</p>`
            : ''}
        </div>

        ${outcome.risks.length > 0
          ? html`
              <ul class="risks">
                ${outcome.risks.map(
                  (risk) => html`
                    <li>
                      <span class="risk-title">${risk.title || `Pane ${risk.paneId}`}</span>
                      <span class="risk-reason">
                        <span class="risk-classification">
                          ${risk.classification === 'busy' ? 'Running work' : 'Activity unknown'}:
                        </span>
                        ${REASON_LABELS[risk.reason]}
                      </span>
                    </li>
                  `,
                )}
              </ul>
            `
          : ''}
        ${outcome.omittedRiskCount > 0
          ? html`
              <p class="omitted">
                ${outcome.omittedRiskCount}
                more risky ${outcome.omittedRiskCount === 1 ? 'pane is' : 'panes are'} not shown.
              </p>
            `
          : ''}

        <div class="actions">
          <mux-ui-button
            class="cancel"
            ?disabled="${this.confirming}"
            @click="${this._emitCancel}"
          >
            Cancel
          </mux-ui-button>
          <mux-ui-button
            class="destructive"
            variant="danger"
            ?disabled="${this.confirming}"
            @click="${this._onConfirm}"
          >
            ${confirmLabel}
          </mux-ui-button>
        </div>
        </div>
      </mux-ui-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'close-confirmation-modal': CloseConfirmationModal;
  }
}
