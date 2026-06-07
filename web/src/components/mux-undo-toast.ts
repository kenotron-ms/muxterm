import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * <mux-undo-toast> — a single countdown toast for a deferred pane close.
 *
 * Lifecycle:
 *   - On connect: start a 1s interval that decrements the visible seconds and
 *     removes the element when it reaches zero (expiry). Expiry dispatches NO
 *     event — mux-app's _executeClose drives the actual kill; the toast simply
 *     disconnects when re-rendered without its entry. (The self-remove here is a
 *     belt-and-suspenders fallback in case the parent has not yet re-rendered.)
 *   - On Undo click: dispatch `pane-close-resolved` (bubbles + composed) so
 *     mux-app cancels the timer and reopens the pane, then remove self.
 *
 * The progress bar animates purely via a CSS width transition (no JS per frame):
 * it starts at 100% and transitions to 0% over `duration`, kicked off in a rAF
 * after connect so the transition has a starting frame to animate from.
 */
@customElement('mux-undo-toast')
export class MuxUndoToast extends LitElement {
  static styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      min-width: 320px;
      max-width: 92vw;
      background: #24283b;
      border: 1px solid #414868;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      color: #c0caf5;
      font-size: 13px;
      overflow: hidden;
      user-select: none;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
    }

    .label {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .undo {
      /* 44px minimum touch target height; width fills at least half the toast so it's easy to hit on narrow screens. */
      min-height: 44px;
      min-width: 44%;
      padding: 0 18px;
      background: #7aa2f7;
      color: #1a1b26;
      border: none;
      border-radius: 6px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.12s;
    }
    .undo:hover { opacity: 0.85; }

    .seconds {
      min-width: 28px;
      text-align: right;
      color: #a9b1d6;
      font-variant-numeric: tabular-nums;
    }

    .track {
      height: 4px;
      background: #1a1b26;
    }
    .bar {
      height: 100%;
      width: 100%;
      background: #7aa2f7;
    }
  `;

  /** The pane this toast can restore. */
  @property({ type: Number }) paneId = -1;
  /** The dockview tab title at close time, e.g. "vim" or "Pane 3". */
  @property({ type: String }) paneTitle = '';
  /** Grace period in milliseconds. */
  @property({ type: Number }) duration = 10000;

  /** Remaining whole seconds shown in the numeric readout. */
  @state() private _remaining = 0;
  /** True once the rAF has fired so the CSS bar transition is armed. */
  @state() private _armed = false;

  private _interval: ReturnType<typeof setInterval> | undefined;
  private _rafHandle: number | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this._remaining = Math.ceil(this.duration / 1000);
    this._interval = setInterval(() => {
      this._remaining -= 1;
      if (this._remaining <= 0) {
        // Expiry fallback — parent re-render normally removes us first.
        this.remove();
      }
    }, 1000);
    // Arm the bar transition on the next frame so it animates from 100% to 0%.
    this._rafHandle = requestAnimationFrame(() => { this._armed = true; });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._rafHandle !== undefined) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = undefined;
    }
    if (this._interval !== undefined) {
      clearInterval(this._interval);
      this._interval = undefined;
    }
  }

  private _onUndo(): void {
    this.dispatchEvent(
      new CustomEvent('pane-close-resolved', {
        detail: { paneId: this.paneId },
        bubbles: true,
        composed: true,
      }),
    );
    this.remove();
  }

  override render() {
    const secs = Math.round(this.duration / 1000);
    // When armed, drive width to 0 over `duration`; before that, full width.
    const barStyle = this._armed
      ? `width:0%;transition:width ${secs}s linear;`
      : `width:100%;`;
    return html`
      <div class="row">
        <span class="label">${this.paneTitle} closed</span>
        <button class="undo" @click=${this._onUndo}>Undo</button>
        <span class="seconds">${this._remaining}s</span>
      </div>
      <div class="track"><div class="bar" style=${barStyle}></div></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-undo-toast': MuxUndoToast;
  }
}
