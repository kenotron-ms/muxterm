import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MuxUIButton } from '../ui/button.js';
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
    dialog {
      width: min(480px, calc(100vw - 32px));
      max-height: min(80dvh, 640px);
      box-sizing: border-box;
      overflow: auto;
      margin: auto;
      padding: 24px;
      border: 1px solid var(--chrome-border);
      border-radius: var(--ui-radius-lg);
      background: var(--ui-surface-overlay);
      background-image: var(--ui-overlay-backdrop-image);
      color: var(--ui-text);
      box-shadow: var(--ui-shadow-overlay);
    }

    dialog::backdrop {
      background: var(--ui-backdrop);
      background-image: var(--ui-app-backdrop-image);
    }

    h2 {
      margin: 0 0 14px;
      font-size: 18px;
      line-height: 1.3;
    }

    .description {
      color: var(--ui-text-muted);
      font-size: 14px;
      line-height: 1.5;
    }

    .description p {
      margin: 8px 0;
    }

    .risks {
      margin: 16px 0 0;
      padding: 0;
      list-style: none;
      border: 1px solid var(--chrome-border);
      border-radius: 7px;
      overflow: hidden;
    }

    .risks li {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--chrome-border);
    }

    .risks li:last-child {
      border-bottom: none;
    }

    .risk-title {
      overflow: hidden;
      color: var(--chrome-text-bright);
      font-size: 13px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .risk-reason,
    .omitted {
      color: var(--ui-text-muted);
      font-size: 12px;
      line-height: 1.4;
    }

    .risk-classification {
      color: var(--chrome-danger);
      font-weight: 600;
    }

    .omitted {
      margin: 10px 0 0;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 22px;
    }

    mux-ui-button { min-width: 96px; }
  `;

  @property({ attribute: false })
  outcome: CloseConfirmationRequiredOutcome | null = null;

  @property({ type: Boolean })
  confirming = false;

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    const dialog = this._dialog;
    if (!this.outcome || !dialog) return;
    if (!dialog.open) dialog.showModal();
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

  private get _dialog(): HTMLDialogElement | null {
    return this.shadowRoot?.querySelector('dialog') ?? null;
  }

  private _emitCancel(): void {
    if (this.confirming) return;
    this._dialog?.close();
    this.dispatchEvent(
      new CustomEvent('close-confirmation-cancel', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onNativeCancel(e: Event): void {
    e.preventDefault();
    this._emitCancel();
  }

  private _onBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) this._emitCancel();
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

    return html`
      <dialog
        aria-labelledby="close-confirmation-title"
        aria-describedby="close-confirmation-description"
        @cancel="${this._onNativeCancel}"
        @click="${this._onBackdropClick}"
        @keydown="${this._onKeyDown}"
      >
        <h2 id="close-confirmation-title">${title}</h2>
        <div id="close-confirmation-description" class="description">
          ${outcome.busyCount > 0
            ? html`<p>Running work will terminate if you close this ${noun}.</p>`
            : ''}
          ${outcome.unknownCount > 0
            ? html`<p>Activity cannot be determined and work may terminate if you close this ${noun}.</p>`
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
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'close-confirmation-modal': CloseConfirmationModal;
  }
}
