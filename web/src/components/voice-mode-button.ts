/**
 * Shared entry control for the app-wide conversational voice session.
 *
 * Product callers leave `snapshot` unset and this element observes the one
 * controller singleton. The public snapshot property is also a normal
 * rendering interface for isolated visual fixtures; it does not create or
 * fake a session.
 */

import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  voiceSessionController,
  type VoiceSessionSnapshot,
} from '../lib/voice-session-controller.js';
import './voice-mode-icon.js';

function isActive(snapshot: VoiceSessionSnapshot): boolean {
  return snapshot.state !== 'idle' && snapshot.state !== 'error';
}

function unavailableReason(snapshot: VoiceSessionSnapshot): string {
  if (!snapshot.available) return 'App voice is not enabled for this running server.';
  if (!snapshot.supported) return 'This browser cannot start a WebRTC voice session.';
  return '';
}

function statusLabel(snapshot: VoiceSessionSnapshot): string {
  if (snapshot.state === 'error') return 'Error';
  if (snapshot.muted) return 'Mic muted';
  switch (snapshot.state) {
    case 'connecting':
      return 'Connecting';
    case 'thinking':
      return 'Thinking';
    case 'speaking':
      return 'Speaking';
    default:
      return 'Listening';
  }
}

@customElement('mux-voice-mode-button')
export class MuxVoiceModeButton extends LitElement {
  static styles = css`
    :host {
      --voice-mode-target: 44px;
      display: inline-flex;
      width: var(--voice-mode-target);
      flex: none;
      min-width: 44px;
      height: var(--voice-mode-target);
      min-height: 44px;
      box-sizing: border-box;
    }

    .control {
      width: 100%;
      min-width: 0;
      height: 100%;
      min-height: 0;
      display: grid;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--chrome-text-bright, currentColor);
      cursor: pointer;
    }

    .control:hover:not(:disabled),
    .control:focus-visible {
      outline: 2px solid var(--chrome-accent, currentColor);
      outline-offset: -2px;
      background: var(--chrome-hover, transparent);
    }

    .control[data-state='connecting'] {
      color: var(--chrome-accent, currentColor);
    }

    .control[data-state='listening'] {
      color: var(--mux-ok, var(--chrome-text-bright, currentColor));
    }

    .control[data-state='thinking'],
    .control[data-state='speaking'] {
      color: var(--chrome-accent, currentColor);
    }

    .control[data-state='error'] {
      color: var(--mux-error, var(--chrome-danger, currentColor));
    }

    .control[data-muted='true'] {
      color: var(--mux-warn, var(--chrome-text-bright, currentColor));
    }

    .control:disabled {
      color: var(--chrome-text-dim, currentColor);
      cursor: not-allowed;
      opacity: 0.64;
    }

    .control[aria-pressed='true'] {
      background: var(--chrome-hover, #303338);
      outline: 1px solid currentColor;
      outline-offset: -4px;
    }

    :host([menu-trigger]) .control {
      border-radius: 50%;
      outline: none;
    }

    mux-voice-mode-icon {
      width: var(--voice-mode-icon-size, 24px);
      height: var(--voice-mode-icon-size, 24px);
    }

    .screen-reader {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  `;

  /**
   * Optional presentation input. App UI uses controller subscription by
   * leaving this undefined; fixture callers may provide a typed snapshot.
   */
  @property({ attribute: false }) snapshot: VoiceSessionSnapshot | undefined;

  /** A bubble uses the same mark as a menu opener rather than a direct toggle. */
  @property({ type: Boolean, attribute: 'menu-trigger' }) menuTrigger = false;

  @state() private _liveSnapshot: VoiceSessionSnapshot = voiceSessionController.snapshot();
  private _unsubscribe: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._liveSnapshot = voiceSessionController.snapshot();
    this._unsubscribe = voiceSessionController.subscribe((snapshot) => {
      if (this.snapshot === undefined) this._liveSnapshot = snapshot;
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  override focus(options?: FocusOptions): void {
    this.renderRoot.querySelector<HTMLButtonElement>('.control')?.focus(options);
  }

  private _onClick = (event: MouseEvent): void => {
    if (this.menuTrigger) {
      this.dispatchEvent(
        new CustomEvent('voice-mode-menu-request', {
          bubbles: true,
          composed: true,
          detail: { pointerActivation: event.detail > 0 },
        }),
      );
      return;
    }
    void voiceSessionController.toggle();
  };

  override render() {
    const snapshot = this.snapshot ?? this._liveSnapshot;
    const active = isActive(snapshot);
    const unavailable = unavailableReason(snapshot);
    const actionLabel = active ? 'Stop voice mode' : 'Start voice mode';
    const label = this.menuTrigger ? `Voice controls: ${statusLabel(snapshot)}` : actionLabel;
    const descriptionId = unavailable ? 'voice-mode-unavailable' : undefined;

    return html`
      <button
        class="control"
        type="button"
        data-voice-mode-button
        data-state="${snapshot.state}"
        data-muted="${String(snapshot.muted)}"
        title="${unavailable || actionLabel}"
        aria-label="${label}"
        aria-pressed="${active ? 'true' : 'false'}"
        aria-busy="${snapshot.state === 'connecting' ? 'true' : 'false'}"
        aria-describedby="${descriptionId ?? nothing}"
        ?disabled="${!this.menuTrigger && !active && unavailable !== ''}"
        @click="${this._onClick}"
      >
        <mux-voice-mode-icon
          .state="${snapshot.state}"
          .level="${snapshot.level}"
          .muted="${snapshot.muted}"
        ></mux-voice-mode-icon>
      </button>
      ${unavailable
        ? html`<span id="voice-mode-unavailable" class="screen-reader">${unavailable}</span>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-voice-mode-button': MuxVoiceModeButton;
  }
}