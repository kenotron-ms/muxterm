import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  recoveredHistoryStore,
  type RecoveredHistorySnapshot,
} from '../lib/recovered-history-store.js';

@customElement('mux-recovered-history')
export class MuxRecoveredHistory extends LitElement {
  static styles = css`
    :host {
      display: block;
      flex: none;
      max-block-size: min(32vh, 20rem);
      overflow: hidden;
    }

    section {
      box-sizing: border-box;
      display: flex;
      max-block-size: inherit;
      flex-direction: column;
      overflow: hidden;
      border-bottom: 1px solid var(--chrome-border);
      background: var(--chrome-body);
      color: var(--chrome-text-bright);
    }

    h2,
    p,
    pre {
      margin: 0;
    }

    h2,
    p {
      padding-inline: 12px;
    }

    h2 {
      padding-block-start: 8px;
      font-size: 13px;
      font-weight: 650;
    }

    p {
      padding-block-start: 2px;
      color: var(--chrome-text-dim);
      font-size: 12px;
      line-height: 1.35;
    }

    .truncation {
      color: var(--mux-warn);
    }

    pre {
      min-block-size: 0;
      max-block-size: 16rem;
      margin-block-start: 6px;
      padding: 8px 12px;
      overflow: auto;
      white-space: pre;
      user-select: text;
      color: var(--mux-fg);
      background: var(--chrome-hover);
      font-family: 'JetBrainsMonoNerdFont', 'SF Mono', monospace;
      font-size: 12px;
      line-height: 1.35;
    }

    pre:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: -2px;
    }
  `;

  @property({ attribute: false, reflect: false })
  workspaceId: string | null | undefined = undefined;

  @property({ attribute: false, reflect: false })
  paneId: number | null | undefined = undefined;

  @state()
  private _snapshot: RecoveredHistorySnapshot = recoveredHistoryStore.snapshot();

  private _unsubscribe: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._snapshot = recoveredHistoryStore.snapshot();
    this._unsubscribe ??= recoveredHistoryStore.subscribe((snapshot) => {
      this._snapshot = snapshot;
    });
  }

  override disconnectedCallback(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
    recoveredHistoryStore.clearAll();
    super.disconnectedCallback();
  }

  override render() {
    const workspaceId = this.workspaceId;
    const paneId = this.paneId;
    const record =
      typeof workspaceId !== 'string' || typeof paneId !== 'number'
        ? undefined
        : this._snapshot.records.find(
            (candidate) =>
              candidate.workspaceId === workspaceId && candidate.paneId === paneId,
          );
    if (!record) return nothing;

    return html`
      <section aria-labelledby="recovered-history-heading" aria-describedby="recovered-history-boundary">
        <h2 id="recovered-history-heading">Recovered terminal history</h2>
        <p id="recovered-history-boundary">Recovery boundary — live terminal output follows.</p>
        ${record.truncated
          ? html`<p class="truncation">Older recovered output was omitted.</p>`
          : nothing}
        <pre tabindex="0">${record.text}</pre>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-recovered-history': MuxRecoveredHistory;
  }
}