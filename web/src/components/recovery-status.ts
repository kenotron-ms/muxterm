import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type {
  SessiondPaneRecoveryInfo,
  SessiondRecoveryDetailCode,
  SessiondRecoveryStatus,
  SessiondRecoveryStrategyLabel,
} from '../types.js';

export interface RecoverySelectionEventDetail {
  candidateHandle: string;
}

const STATUS_COPY: Readonly<
  Record<SessiondRecoveryStatus, { readonly heading: string; readonly message: string }>
> = {
  restoring: {
    heading: 'Restoring',
    message: 'Muxterm is restoring this pane.',
  },
  recovered: {
    heading: 'Recovered',
    message: 'The durable conversation is available.',
  },
  'shell-restored': {
    heading: 'Shell restored',
    message: 'A fresh shell is available.',
  },
  'selection-needed': {
    heading: 'Choose a durable session',
    message: 'Select a daemon-provided recovery candidate.',
  },
  provisional: {
    heading: 'Recovery not yet verified',
    message: 'The resumed conversation could not be verified yet.',
  },
  'strategy-failed': {
    heading: 'Recovery failed',
    message: 'The pane remains usable as a shell.',
  },
};

const DETAIL_COPY: Readonly<
  Record<Exclude<SessiondRecoveryDetailCode, 'none'>, string>
> = {
  'capture-missing': 'No durable session was captured.',
  'capture-invalid': 'The saved recovery information is invalid.',
  'capture-stale': 'The saved recovery information is out of date.',
  'capture-conflicting': 'Saved recovery information conflicts.',
  'capture-ambiguous': 'More than one durable session could match.',
  'working-directory-invalid': 'The saved working directory is unavailable.',
  'strategy-unsupported': 'This recovery strategy is unavailable.',
  'schema-incompatible': 'The saved recovery data is incompatible.',
  'lifecycle-unavailable': 'Recovery integration information is unavailable.',
  'lifecycle-expired': 'Recovery integration information expired.',
  'lifecycle-malformed': 'Recovery integration information is invalid.',
  'lifecycle-zero': 'Recovery integration information is incomplete.',
  'lifecycle-unknown': 'Recovery integration information is not recognized.',
  'lifecycle-replayed': 'Recovery integration information was already used.',
  'lifecycle-stale': 'Recovery integration information is out of date.',
  'lifecycle-cross-pane': 'Recovery information belongs to another pane.',
  'lifecycle-cross-strategy': 'Recovery information belongs to another strategy.',
  'lifecycle-conflicting': 'Recovery integration information conflicts.',
  'launch-rejected': 'The recovery launch was rejected.',
  'launch-failed': 'The recovery launch failed.',
  'observed-identity-mismatch': 'The resumed conversation did not match.',
  'readiness-timeout': 'The resumed conversation did not become ready.',
  'replacement-deferred': 'Recovery replacement was deferred.',
  'replacement-failed': 'Recovery replacement failed.',
  'replacement-plan-invalid': 'The recovery replacement plan is no longer valid.',
  'active-pane-invalid': 'The active pane selection was rejected.',
  'candidate-invalid': 'The recovery candidate is no longer valid.',
};

const VISIBLE_STRATEGY_LABELS = new Set<SessiondRecoveryStrategyLabel>([
  'Amplifier',
  'Claude Code',
  'OpenCode',
  'Codex',
]);

function visibleStrategyLabel(value: unknown): SessiondRecoveryStrategyLabel | null {
  return typeof value === 'string' && VISIBLE_STRATEGY_LABELS.has(value as SessiondRecoveryStrategyLabel)
    ? (value as SessiondRecoveryStrategyLabel)
    : null;
}

@customElement('mux-recovery-status')
export class MuxRecoveryStatus extends LitElement {
  static styles = css`
    :host {
      display: block;
      flex: none;
    }

    section {
      box-sizing: border-box;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
      min-height: 44px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--chrome-border);
      background: var(--chrome-body);
      color: var(--chrome-text-bright);
      font-size: 13px;
      line-height: 1.35;
    }

    .copy {
      display: flex;
      flex: 1 1 260px;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 2px 8px;
      min-width: 0;
    }

    h2,
    p {
      margin: 0;
    }

    h2 {
      color: var(--chrome-text-bright);
      font-size: 13px;
      font-weight: 650;
    }

    p {
      color: var(--chrome-text-dim);
    }

    .strategy {
      color: var(--chrome-text-bright);
    }

    .detail,
    .boundary {
      flex-basis: 100%;
    }

    .actions {
      display: flex;
      flex: 0 1 auto;
      flex-wrap: wrap;
      gap: 8px;
    }

    button {
      min-height: 44px;
      padding: 8px 12px;
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
      background: var(--chrome-hover);
      color: var(--chrome-text-bright);
      font: inherit;
      cursor: pointer;
    }

    button:not(:disabled):hover {
      border-color: var(--chrome-accent);
    }

    button:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
  `;

  @property({ attribute: false, reflect: false })
  recovery: SessiondPaneRecoveryInfo | null = null;

  @property({ type: Boolean, attribute: false, reflect: false })
  retryEnabled = false;

  @property({ type: Boolean, attribute: false, reflect: false })
  selectionEnabled = false;

  private _emitRetry(): void {
    const recovery = this.recovery;
    if (
      !recovery ||
      recovery.status !== 'strategy-failed' ||
      !recovery.canRetry ||
      !this.retryEnabled
    ) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent('recovery-retry', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _emitSelection(candidateHandle: string): void {
    const recovery = this.recovery;
    if (
      !recovery ||
      recovery.status !== 'selection-needed' ||
      !recovery.canSelect ||
      !this.selectionEnabled ||
      !recovery.selectionCandidates.some((candidate) => candidate.candidateHandle === candidateHandle)
    ) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<RecoverySelectionEventDetail>('recovery-select', {
        detail: { candidateHandle },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const recovery = this.recovery;
    if (!recovery) return nothing;

    const status = STATUS_COPY[recovery.status];
    const strategyLabel = visibleStrategyLabel(recovery.strategyLabel);
    const detail = recovery.detailCode === 'none' ? null : DETAIL_COPY[recovery.detailCode];
    const retryAvailable =
      recovery.status === 'strategy-failed' && recovery.canRetry && this.retryEnabled;
    const candidates =
      recovery.status === 'selection-needed'
        ? recovery.selectionCandidates
            .map((candidate) => ({
              candidateHandle: candidate.candidateHandle,
              strategyLabel: visibleStrategyLabel(candidate.strategyLabel),
            }))
            .filter(
              (
                candidate,
              ): candidate is {
                candidateHandle: string;
                strategyLabel: SessiondRecoveryStrategyLabel;
              } => candidate.strategyLabel !== null,
            )
        : [];
    const selectionAvailable =
      recovery.status === 'selection-needed' && recovery.canSelect && this.selectionEnabled;

    return html`
      <section role="status" aria-live="polite" aria-atomic="true">
        <div class="copy">
          <h2>${status.heading}</h2>
          <p>${status.message}</p>
          ${strategyLabel ? html`<p class="strategy">Strategy: ${strategyLabel}</p>` : nothing}
          ${detail ? html`<p class="detail">${detail}</p>` : nothing}
          ${recovery.historyBoundary
            ? html`<p class="boundary">Recovered history boundary: recent terminal output may be missing.</p>`
            : nothing}
        </div>
        ${recovery.status === 'strategy-failed'
          ? html`
              <div class="actions">
                <button type="button" ?disabled="${!retryAvailable}" @click="${this._emitRetry}">
                  Retry recovery
                </button>
              </div>
            `
          : nothing}
        ${recovery.status === 'selection-needed'
          ? html`
              <div class="actions">
                ${candidates.map(
                  (candidate) => html`
                    <button
                      type="button"
                      ?disabled="${!selectionAvailable}"
                      @click="${() => this._emitSelection(candidate.candidateHandle)}"
                    >
                      Resume ${candidate.strategyLabel}
                    </button>
                  `,
                )}
              </div>
            `
          : nothing}
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-recovery-status': MuxRecoveryStatus;
  }
}