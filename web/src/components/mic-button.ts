/**
 * <mux-mic-button> — dedicated dictation button for the mobile title bar.
 *
 * Thin Lit component: all SpeechRecognition state lives in
 * voice-input-controller.ts (a singleton, imported here, never instantiated
 * per-component). This component only renders UI, subscribes to the
 * controller's pub/sub API, and forwards its own DOM events.
 *
 * See docs/designs/2026-07-31-voice-input-design.md's "Visual & UX Spec" and
 * "Architecture" sections for the full rationale behind each state below.
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { icon } from '../lib/icons.js';
import { Mic, MicOff } from 'lucide';
import { voiceInputController, type VoiceState } from '../lib/voice-input-controller.js';

@customElement('mux-mic-button')
export class MuxMicButton extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
    }

    .mic-btn {
      width: var(--mux-dock-height, 44px);
      height: var(--mux-dock-height, 44px);
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--chrome-text-bright);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-family: inherit;
    }

    .mic-btn:hover:not(:disabled) {
      background: var(--chrome-hover);
    }

    .mic-btn.listening {
      background: var(--chrome-danger);
      color: var(--chrome-body);
      animation: mic-pulse 1.5s ease-in-out infinite;
    }

    .mic-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    @keyframes mic-pulse {
      0%, 100% {
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--chrome-danger) 55%, transparent);
      }
      50% {
        box-shadow: 0 0 0 6px color-mix(in srgb, var(--chrome-danger) 0%, transparent);
      }
    }

    .toast {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 950;
      min-width: 240px;
      max-width: 92vw;
      box-sizing: border-box;
      min-height: 44px;
      padding: 10px 14px;
      background: var(--chrome-bar);
      border: 1px solid var(--chrome-border);
      border-radius: 8px;
      color: var(--chrome-text-bright);
      font-size: 13px;
      text-align: center;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }

    button .lucide-icon {
      pointer-events: none;
    }
  `;

  @state() private _version = 0;
  @state() private _voiceState: VoiceState = voiceInputController.getState();
  @state() private _toastMessage: string | null = null;

  private _unsubscribeStore: (() => void) | null = null;
  private _unsubscribeState: (() => void) | null = null;
  private _unsubscribeTranscript: (() => void) | null = null;
  private _unsubscribeError: (() => void) | null = null;
  private _toastTimer: ReturnType<typeof setTimeout> | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this._unsubscribeStore = store.subscribe(() => {
      this._version++;
    });
    this._unsubscribeState = voiceInputController.onStateChange((s) => {
      this._voiceState = s;
    });
    this._unsubscribeTranscript = voiceInputController.onTranscript((payload) => {
      this.dispatchEvent(
        new CustomEvent('voice-transcript', {
          bubbles: true,
          composed: true,
          detail: payload,
        }),
      );
    });
    this._unsubscribeError = voiceInputController.onError((message) => {
      this._showToast(message);
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribeStore?.();
    this._unsubscribeStore = null;
    this._unsubscribeState?.();
    this._unsubscribeState = null;
    this._unsubscribeTranscript?.();
    this._unsubscribeTranscript = null;
    this._unsubscribeError?.();
    this._unsubscribeError = null;
    if (this._toastTimer !== undefined) clearTimeout(this._toastTimer);
    // The title bar (and this component with it) unmounts entirely on the
    // narrow-to-wide breakpoint transition. Without this, the singleton
    // controller could keep an orphaned recognition session running with no
    // visible UI control over it.
    voiceInputController.invalidateIfActive();
  }

  private _showToast(message: string): void {
    if (this._toastTimer !== undefined) clearTimeout(this._toastTimer);
    this._toastMessage = message;
    this._toastTimer = setTimeout(() => {
      this._toastMessage = null;
      this._toastTimer = undefined;
    }, 3000);
  }

  private _onClick = (): void => {
    if (this._voiceState === 'listening') {
      voiceInputController.stop();
    } else {
      voiceInputController.start();
    }
  };

  override render() {
    // Reactive dependency on store changes (pane focus/kind can change on
    // every tab switch).
    void this._version;

    if (!voiceInputController.isSupported()) return html``;

    const activePane = store.panes.find((p) => p.paneId === store.activePaneId);
    // Every pane is a terminal, so an active pane is always a valid target.
    const hasValidTarget = !!activePane;
    const listening = this._voiceState === 'listening';

    const label = !hasValidTarget
      ? 'Voice input requires a terminal pane'
      : listening
        ? 'Stop voice input'
        : 'Start voice input';

    return html`
      <button
        class="mic-btn ${listening ? 'listening' : ''}"
        title="${label}"
        aria-label="${label}"
        ?disabled="${!hasValidTarget}"
        @click="${this._onClick}"
      >${icon(listening ? MicOff : Mic, { size: 18 })}</button>
      ${this._toastMessage ? html`<div class="toast" role="alert">${this._toastMessage}</div>` : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-mic-button': MuxMicButton;
  }
}
