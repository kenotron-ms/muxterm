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

import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { store, type MuxStore } from '../state.js';
import { icon } from '../lib/icons.js';
import { Mic, MicOff } from 'lucide';
import { voiceInputController, type VoiceState } from '../lib/voice-input-controller.js';
import '../ui/button.js';
import '../ui/feedback.js';

export type VoiceInputPort = Pick<typeof voiceInputController,
  'isSupported' | 'getState' | 'onStateChange' | 'onTranscript' | 'onError' |
  'invalidateIfActive' | 'start' | 'stop'>;

@customElement('mux-mic-button')
export class MuxMicButton extends LitElement {
  /** Storybook supplies isolated ports; the app keeps its shared authorities. */
  @property({ attribute: false }) paneStore: MuxStore = store;
  @property({ attribute: false }) voiceController: VoiceInputPort = voiceInputController;

  static styles = css`
    :host {
      display: inline-flex;
    }

    .mic-btn {
      width: var(--ui-control-lg);
      height: var(--ui-control-lg);
    }

    .mic-btn.listening::part(button) {
      background: var(--ui-danger);
      color: var(--ui-on-danger);
      animation: mic-pulse var(--ui-motion-pulse) ease-in-out infinite;
    }

    .icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    @keyframes mic-pulse {
      0%, 100% {
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--ui-danger) 55%, transparent);
      }
      50% {
        box-shadow: 0 0 0 var(--ui-space-3) transparent;
      }
    }

    .toast {
      position: fixed;
      bottom: var(--ui-toast-offset);
      left: 50%;
      transform: translateX(-50%);
      z-index: var(--ui-z-toast);
      min-width: min(var(--ui-toast-min-width), 92vw);
      max-width: 92vw;
      box-sizing: border-box;
      box-shadow: var(--ui-shadow-menu);
    }

    @media (prefers-reduced-motion: reduce) {
      .mic-btn.listening::part(button) { animation: none; }
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

  private _subscribeStore(): void {
    this._unsubscribeStore?.();
    this._unsubscribeStore = this.paneStore.subscribe(() => {
      this._version++;
    });
  }

  private _subscribeVoice(): void {
    this._unsubscribeState?.();
    this._unsubscribeTranscript?.();
    this._unsubscribeError?.();
    this._voiceState = this.voiceController.getState();
    this._unsubscribeState = this.voiceController.onStateChange((s) => {
      this._voiceState = s;
    });
    this._unsubscribeTranscript = this.voiceController.onTranscript((payload) => {
      if (payload.target !== 'terminal' || payload.kind !== 'final') return;
      this.dispatchEvent(
        new CustomEvent('voice-transcript', {
          bubbles: true,
          composed: true,
          detail: payload,
        }),
      );
    });
    this._unsubscribeError = this.voiceController.onError((message) => {
      this._showToast(message);
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._subscribeStore();
    this._subscribeVoice();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!this.isConnected) return;
    if (changed.has('paneStore')) this._subscribeStore();
    if (changed.has('voiceController')) this._subscribeVoice();
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
    this.voiceController.invalidateIfActive();
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
      this.voiceController.stop();
    } else {
      this.voiceController.start();
    }
  };

  override render() {
    // Reactive dependency on store changes (pane focus/kind can change on
    // every tab switch).
    void this._version;

    if (!this.voiceController.isSupported()) return html``;

    const activePane = this.paneStore.panes.find((p) => p.paneId === this.paneStore.activePaneId);
    // Every pane is a terminal, so an active pane is always a valid target.
    const hasValidTarget = !!activePane;
    const listening = this._voiceState === 'listening';

    const label = !hasValidTarget
      ? 'Voice input requires a terminal pane'
      : listening
        ? 'Stop voice input'
        : 'Start voice input';

    return html`
      <mux-ui-button
        class="mic-btn ${listening ? 'listening' : ''}"
        variant="quiet"
        size="large"
        icon-only
        .accessibleLabel="${label}"
        .tooltip="${label}"
        .disabled="${!hasValidTarget}"
        @click="${this._onClick}"
      ><span class="icon" slot="leading">${icon(listening ? MicOff : Mic, { size: 18 })}</span></mux-ui-button>
      ${this._toastMessage ? html`<div class="toast"><mux-ui-feedback kind="error" appearance="panel" align="center">${this._toastMessage}</mux-ui-feedback></div>` : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-mic-button': MuxMicButton;
  }
}
