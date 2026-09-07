import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * What the user stares at while the socket is down.
 *
 * Its one job is to not lie. The old overlay said "Reconnecting..." over a
 * spinning spinner for the entire outage, including the fifteen seconds the
 * client spent asleep in a backoff timer doing nothing at all -- which is
 * exactly when a user, seeing motion, waits instead of acting. So the three
 * states are told apart:
 *
 *   retrying  an attempt is in flight this instant   -> spinner, and it means it
 *   waiting   asleep until nextAttemptAt             -> countdown, no spinner
 *   offline   the browser says there is no network   -> no promise at all
 *
 * and there is one control, Retry now, which really does force an attempt.
 *
 * Deliberately not a dashboard: one state line, one countdown, one button. No
 * attempt counter, no history, no log. Colours come from the --chrome-* theme
 * tokens (applyChromeTokens in lib/theme.ts) so it is legible in light and
 * dark, and it lays out in a narrow column so it survives a phone-width window.
 */
@customElement('mux-reconnect-overlay')
export class MuxReconnectOverlay extends LitElement {
  static styles = css`
    .overlay {
      position: fixed;
      inset: 0;
      /* Dimmer over the app, not a fixed black: on a light palette a solid
         black wash makes the dialog text below it unreadable. */
      background: color-mix(in srgb, var(--chrome-body, #1a1b26) 82%, transparent);
      z-index: 2000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      box-sizing: border-box;
    }

    .container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      max-width: 320px;
      width: 100%;
      text-align: center;
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 3px solid var(--chrome-border, #414868);
      border-top-color: var(--chrome-accent, #7aa2f7);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    /* Same footprint as the spinner so the dialog does not jump between the
       waiting and retrying states. */
    .dot {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--chrome-border, #414868);
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .message {
      font-size: 16px;
      color: var(--chrome-text-bright, #c0caf5);
      overflow-wrap: anywhere;
    }

    .detail {
      font-size: 13px;
      color: var(--chrome-text-dim, #565f89);
      overflow-wrap: anywhere;
    }

    button {
      font: inherit;
      font-size: 13px;
      padding: 6px 14px;
      border-radius: 6px;
      border: 1px solid var(--chrome-border, #414868);
      background: transparent;
      color: var(--chrome-text-bright, #c0caf5);
      cursor: pointer;
    }

    button:hover:not(:disabled) {
      border-color: var(--chrome-accent, #7aa2f7);
      color: var(--chrome-accent, #7aa2f7);
    }

    button:disabled {
      opacity: 0.5;
      cursor: default;
    }

    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation: none;
      }
    }
  `;

  /** 'retrying' | 'waiting' | 'offline' — mirrors ws.ts's ReconnectState. */
  @property({ type: String })
  phase: 'retrying' | 'waiting' | 'offline' = 'retrying';

  /** Epoch-ms the next attempt is due. Only meaningful while waiting. */
  @property({ type: Number })
  nextAttemptAt = 0;

  /**
   * Server-supplied reason, when there is one (the `detached` control frame).
   * Overrides the derived headline: the server knows something we do not.
   */
  @property({ type: String })
  message = '';

  @state()
  private _now = Date.now();

  private _tick: ReturnType<typeof setInterval> | undefined;

  connectedCallback(): void {
    super.connectedCallback();
    // 250ms, not 1000: the countdown must not appear to stall on a ladder
    // whose early rungs are 300ms long.
    this._tick = setInterval(() => {
      this._now = Date.now();
    }, 250);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._tick !== undefined) clearInterval(this._tick);
    this._tick = undefined;
  }

  private _retryNow(): void {
    this.dispatchEvent(new CustomEvent('retry-now', { bubbles: true, composed: true }));
  }

  private _headline(): string {
    if (this.message) return this.message;
    switch (this.phase) {
      case 'offline':
        return "You're offline";
      case 'retrying':
        return 'Reconnecting...';
      case 'waiting':
        return 'Connection lost';
    }
  }

  private _detail(): string {
    switch (this.phase) {
      case 'offline':
        return 'Waiting for the network to come back.';
      case 'retrying':
        return 'Contacting the server...';
      case 'waiting': {
        const secs = Math.max(0, Math.ceil((this.nextAttemptAt - this._now) / 1000));
        return secs <= 1 ? 'Next attempt in under a second' : `Next attempt in ${secs}s`;
      }
    }
  }

  render() {
    const busy = this.phase === 'retrying';
    return html`
      <div class="overlay" role="status" aria-live="polite">
        <div class="container">
          ${busy ? html`<div class="spinner"></div>` : html`<div class="dot"></div>`}
          <div class="message">${this._headline()}</div>
          <div class="detail">${this._detail()}</div>
          ${this.phase === 'offline'
            ? nothing
            : html`<button
                id="retry-now"
                ?disabled=${busy}
                @click=${this._retryNow}
              >Retry now</button>`}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-reconnect-overlay': MuxReconnectOverlay;
  }
}
