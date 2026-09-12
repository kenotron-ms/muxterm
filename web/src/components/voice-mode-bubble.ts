/**
 * The one app-root voice surface. It owns only presentation: the provider
 * connection remains in voice-session-controller and is never affected by
 * navigation, a drag, or this element being detached.
 */

import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  voiceSessionController,
  type VoiceSessionSnapshot,
} from '../lib/voice-session-controller.js';
import './voice-mode-button.js';

type DockEdge = 'left' | 'right';

interface StoredPosition {
  readonly edge: DockEdge;
  readonly vertical: number;
}

interface ViewportBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly middleX: number;
}

interface DragState {
  readonly pointerId: number;
  readonly originX: number;
  readonly originY: number;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
}

const PRESENTATION_STORAGE_KEY = 'muxterm.voice-mode-bubble.presentation.v1';
const DEFAULT_POSITION: StoredPosition = Object.freeze({ edge: 'right', vertical: 0.56 });
const EDGE_GAP = 12;
const DRAG_THRESHOLD = 6;
const SNAP_DURATION_MS = 160;
const FALLBACK_BUBBLE_WIDTH = 84;
const FALLBACK_BUBBLE_HEIGHT = 88;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isStoredPosition(value: unknown): value is StoredPosition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { edge?: unknown; vertical?: unknown };
  return (
    (candidate.edge === 'left' || candidate.edge === 'right') &&
    typeof candidate.vertical === 'number' &&
    Number.isFinite(candidate.vertical)
  );
}

function restorePosition(): StoredPosition {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_POSITION;
    const raw = localStorage.getItem(PRESENTATION_STORAGE_KEY);
    if (!raw) return DEFAULT_POSITION;
    const value: unknown = JSON.parse(raw);
    if (!isStoredPosition(value)) return DEFAULT_POSITION;
    return Object.freeze({
      edge: value.edge,
      vertical: clamp(value.vertical, 0, 1),
    });
  } catch {
    return DEFAULT_POSITION;
  }
}

function visible(snapshot: VoiceSessionSnapshot): boolean {
  return snapshot.state !== 'idle';
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

@customElement('mux-voice-mode-bubble')
export class MuxVoiceModeBubble extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1500;
      display: block;
      pointer-events: none;
      color: var(--chrome-text-bright, currentColor);
    }

    .safe-insets {
      position: absolute;
      width: 0;
      height: 0;
      visibility: hidden;
      pointer-events: none;
      padding:
        env(safe-area-inset-top, 0px)
        env(safe-area-inset-right, 0px)
        env(safe-area-inset-bottom, 0px)
        env(safe-area-inset-left, 0px);
    }

    .bubble {
      position: absolute;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      width: 84px;
      min-height: 88px;
      padding: 0;
      pointer-events: none;
    }

    .bubble[data-positioned='false'] {
      visibility: hidden;
    }

    .bubble[data-snapping='true'] {
      transition: left ${SNAP_DURATION_MS}ms ease-out, top ${SNAP_DURATION_MS}ms ease-out;
    }

    .bubble[data-state='connecting'],
    .bubble[data-state='thinking'],
    .bubble[data-state='speaking'] {
      border-color: var(--chrome-accent, currentColor);
    }

    .bubble[data-state='listening'] {
      border-color: var(--mux-ok, var(--chrome-text-bright, currentColor));
    }

    .bubble[data-state='error'] {
      border-color: var(--mux-error, var(--chrome-danger, currentColor));
    }

    .bubble[data-muted='true'] {
      border-color: var(--mux-warn, var(--chrome-text-bright, currentColor));
    }

    mux-voice-mode-button.bubble-main {
      --voice-mode-target: 60px;
      --voice-mode-icon-size: 38px;
      touch-action: none;
      flex: none;
      border: 1.5px solid currentColor;
      border-radius: 50%;
      background: var(--chrome-bar, #202124);
      pointer-events: auto;
    }

    .status {
      min-width: 0;
      padding: 4px 5px;
      border-radius: 4px;
      background: var(--chrome-bar, #202124);
      font-size: 11px;
      font-weight: 750;
      line-height: 1;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }

    .bubble[data-state='error'] .status {
      color: var(--mux-error, var(--chrome-danger, currentColor));
    }

    .bubble[data-muted='true'] .status {
      color: var(--mux-warn, var(--chrome-text-bright, currentColor));
    }

    .menu {
      position: fixed;
      z-index: 1;
      width: min(288px, calc(100vw - 24px));
      box-sizing: border-box;
      max-height: calc(100dvh - 24px);
      overflow: auto;
      overscroll-behavior: contain;
      pointer-events: auto;
      padding: 8px;
      border: 1px solid var(--chrome-text-dim, currentColor);
      border-radius: 8px;
      background: var(--chrome-bar);
      color: var(--chrome-text-bright, currentColor);
    }

    .bubble[data-edge='left'] .menu {
      left: 0;
    }

    .bubble[data-edge='right'] .menu {
      right: 0;
    }

    .bubble[data-menu-up='true'] .menu {
      bottom: calc(100% + 8px);
    }

    .bubble[data-menu-up='false'] .menu {
      top: calc(100% + 8px);
    }

    .menu-heading {
      margin: 2px 4px 6px;
      font-size: 12px;
      font-weight: 700;
    }

    .menu-status,
    .menu-help {
      margin: 0 4px 8px;
      font-size: 12px;
      line-height: 1.35;
      color: var(--chrome-text-dim, currentColor);
    }

    .menu-actions,
    .dock-actions {
      display: grid;
      gap: 4px;
    }

    .dock-actions {
      grid-template-columns: 1fr 1fr;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--chrome-border, currentColor);
    }

    .menu button {
      min-height: 44px;
      padding: 8px 10px;
      border: 1px solid var(--chrome-border, currentColor);
      border-radius: 5px;
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      text-align: left;
      cursor: pointer;
    }

    .dock-actions button {
      text-align: center;
    }

    .menu button:hover:not(:disabled),
    .menu button:focus-visible {
      outline: 2px solid var(--chrome-accent, currentColor);
      outline-offset: -2px;
      background: var(--chrome-hover, transparent);
    }

    .menu button:disabled {
      cursor: not-allowed;
      opacity: 0.56;
    }

    .stop {
      border-color: var(--mux-error, var(--chrome-danger, currentColor)) !important;
    }

    @media (prefers-reduced-motion: reduce) {
      .bubble[data-snapping='true'] {
        transition: none;
      }
    }
  `;

  /** Presentation input only. App callers leave unset and observe the singleton.
   * A renderer fixture can supply this without starting or changing app voice. */
  @property({ attribute: false }) snapshot: VoiceSessionSnapshot | undefined;
  @state() private _liveSession: VoiceSessionSnapshot = voiceSessionController.snapshot();
  private get _session(): VoiceSessionSnapshot {
    return this.snapshot ?? this._liveSession;
  }
  @state() private _menuOpen = false;
  @state() private _positioned = false;
  @state() private _snapping = false;

  private readonly _storedPosition = restorePosition();
  private _edge: DockEdge = this._storedPosition.edge;
  private _vertical = this._storedPosition.vertical;
  private _x = 0;
  private _y = 0;
  private _drag: DragState | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _positionFrame: number | null = null;
  private _snapTimer: ReturnType<typeof setTimeout> | undefined;
  private _menuInitiator: HTMLElement | null = null;
  private _suppressMenuRequest = false;
  private _visualViewport: VisualViewport | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._liveSession = voiceSessionController.snapshot();
    this._unsubscribe = voiceSessionController.subscribe((snapshot) => {
      if (this.snapshot !== undefined) return;
      const wasVisible = visible(this._session);
      const previousState = this._session.state;
      this._liveSession = snapshot;
      if (!visible(snapshot)) {
        this._menuOpen = false;
        this._menuInitiator = null;
      } else if (!wasVisible || snapshot.state !== previousState) {
        this._queuePosition();
      }
    });
    window.addEventListener('resize', this._onViewportChange);
    window.addEventListener('orientationchange', this._onViewportChange);
    this._visualViewport = window.visualViewport;
    this._visualViewport?.addEventListener('resize', this._onViewportChange);
    this._visualViewport?.addEventListener('scroll', this._onViewportChange);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
    window.removeEventListener('resize', this._onViewportChange);
    window.removeEventListener('orientationchange', this._onViewportChange);
    this._visualViewport?.removeEventListener('resize', this._onViewportChange);
    this._visualViewport?.removeEventListener('scroll', this._onViewportChange);
    this._visualViewport = null;
    if (this._positionFrame !== null) cancelAnimationFrame(this._positionFrame);
    this._positionFrame = null;
    if (this._snapTimer !== undefined) clearTimeout(this._snapTimer);
    this._snapTimer = undefined;
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('snapshot') || changed.has('_liveSession')) {
      const previous = changed.get(changed.has('snapshot') ? 'snapshot' : '_liveSession') as VoiceSessionSnapshot | undefined;
      if (!visible(this._session)) {
        this._menuOpen = false;
      } else if (!previous || previous.state !== this._session.state || previous.muted !== this._session.muted) {
        this._queuePosition();
      }
    }
    if (changed.has('_menuOpen') && this._menuOpen) this._placeMenu();
  }

  private _bubble(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('.bubble');
  }

  private _safeInsets(): { top: number; right: number; bottom: number; left: number } {
    const probe = this.renderRoot.querySelector<HTMLElement>('.safe-insets');
    if (!probe) return { top: 0, right: 0, bottom: 0, left: 0 };
    const style = getComputedStyle(probe);
    return {
      top: Number.parseFloat(style.paddingTop) || 0,
      right: Number.parseFloat(style.paddingRight) || 0,
      bottom: Number.parseFloat(style.paddingBottom) || 0,
      left: Number.parseFloat(style.paddingLeft) || 0,
    };
  }

  private _bounds(): ViewportBounds {
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const insets = this._safeInsets();
    const rect = this._bubble()?.getBoundingClientRect();
    const bubbleWidth = rect?.width || FALLBACK_BUBBLE_WIDTH;
    const bubbleHeight = rect?.height || FALLBACK_BUBBLE_HEIGHT;
    const minX = left + insets.left + EDGE_GAP;
    const maxX = Math.max(minX, left + width - insets.right - bubbleWidth - EDGE_GAP);
    const minY = top + insets.top + EDGE_GAP;
    const maxY = Math.max(minY, top + height - insets.bottom - bubbleHeight - EDGE_GAP);
    return {
      minX,
      maxX,
      minY,
      maxY,
      middleX: left + width / 2,
    };
  }

  private _applyPosition(): void {
    const bubble = this._bubble();
    if (!bubble) return;
    bubble.style.left = `${this._x}px`;
    bubble.style.top = `${this._y}px`;
    if (this._menuOpen) this._placeMenu();
  }

  private _placeMenu(): void {
    const menu = this.renderRoot.querySelector<HTMLElement>('.menu');
    if (!menu) return;
    const viewport = window.visualViewport;
    const insets = this._safeInsets();
    const left = (viewport?.offsetLeft ?? 0) + insets.left + EDGE_GAP;
    const top = (viewport?.offsetTop ?? 0) + insets.top + EDGE_GAP;
    const right = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - insets.right - EDGE_GAP;
    const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - insets.bottom - EDGE_GAP;
    menu.style.maxHeight = `${Math.max(44, bottom - top)}px`;
    menu.style.width = `${Math.max(44, Math.min(288, right - left))}px`;
    const height = menu.getBoundingClientRect().height;
    const y = this._vertical > 0.5 ? this._y - height - 8 : this._y + FALLBACK_BUBBLE_HEIGHT + 8;
    menu.style.left = `${clamp(this._x, left, Math.max(left, right - menu.getBoundingClientRect().width))}px`;
    menu.style.top = `${clamp(y, top, Math.max(top, bottom - height))}px`;
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
  }

  private _placeAtStoredPosition(): void {
    const bounds = this._bounds();
    this._x = this._edge === 'left' ? bounds.minX : bounds.maxX;
    this._y = bounds.minY + (bounds.maxY - bounds.minY) * this._vertical;
    this._applyPosition();
    if (!this._positioned) this._positioned = true;
  }

  private _queuePosition = (): void => {
    if (this._positionFrame !== null || !visible(this._session)) return;
    this._positionFrame = requestAnimationFrame(() => {
      this._positionFrame = null;
      if (this._drag) {
        const bounds = this._bounds();
        this._x = clamp(this._x, bounds.minX, bounds.maxX);
        this._y = clamp(this._y, bounds.minY, bounds.maxY);
        this._applyPosition();
        return;
      }
      this._placeAtStoredPosition();
    });
  };

  private _onViewportChange = (): void => {
    this._queuePosition();
  };

  private _persistPosition(): void {
    try {
      localStorage.setItem(
        PRESENTATION_STORAGE_KEY,
        JSON.stringify({ edge: this._edge, vertical: this._vertical }),
      );
    } catch {
      // Storage is a convenience only; an unavailable store must not block UI.
    }
  }

  private _reducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  private _finishSnap(): void {
    this._snapping = false;
    this._snapTimer = undefined;
  }

  private _commitDragPosition(animate: boolean): void {
    const bounds = this._bounds();
    const rect = this._bubble()?.getBoundingClientRect();
    const bubbleWidth = rect?.width || FALLBACK_BUBBLE_WIDTH;
    this._edge = this._x + bubbleWidth / 2 < bounds.middleX ? 'left' : 'right';
    this._vertical =
      bounds.maxY === bounds.minY ? 0 : clamp((this._y - bounds.minY) / (bounds.maxY - bounds.minY), 0, 1);
    if (animate && !this._reducedMotion()) {
      if (this._snapTimer !== undefined) clearTimeout(this._snapTimer);
      this._snapping = true;
      const bubble = this._bubble();
      if (bubble) {
        bubble.dataset.snapping = 'true';
        void bubble.offsetWidth;
      }
      this._snapTimer = setTimeout(() => this._finishSnap(), SNAP_DURATION_MS);
    }
    this._placeAtStoredPosition();
    this._persistPosition();
  }

  private _onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (this._drag) return;
    this._suppressMenuRequest = false;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    target.setPointerCapture(event.pointerId);
    this._drag = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startX: this._x,
      startY: this._y,
      moved: false,
    };
  };

  private _onPointerMove = (event: PointerEvent): void => {
    const drag = this._drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = event.clientX - drag.originX;
    const deltaY = event.clientY - drag.originY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      this._closeMenu(false);
    }
    const bounds = this._bounds();
    this._x = clamp(drag.startX + deltaX, bounds.minX, bounds.maxX);
    this._y = clamp(drag.startY + deltaY, bounds.minY, bounds.maxY);
    this._applyPosition();
  };

  private _endPointer = (event: PointerEvent, cancelled: boolean): void => {
    const drag = this._drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    this._drag = null;
    if (drag.moved) {
      this._suppressMenuRequest = true;
      this._commitDragPosition(!cancelled);
      return;
    }
    if (cancelled) {
      this._suppressMenuRequest = true;
      this._queuePosition();
      return;
    }
    this._suppressMenuRequest = true;
    this._openMenu(target instanceof HTMLElement ? target : null);
  };

  private _onPointerUp = (event: PointerEvent): void => {
    this._endPointer(event, false);
  };

  private _onPointerCancel = (event: PointerEvent): void => {
    this._endPointer(event, true);
  };

  private _onMenuRequest = (event: Event): void => {
    event.stopPropagation();
    const pointerActivation = (event as CustomEvent<{ pointerActivation?: boolean }>).detail?.pointerActivation === true;
    // Only suppress the compatibility click from the completed pointer
    // gesture. A cancelled pointer can have no subsequent click at all;
    // it must never swallow the next keyboard/assistive activation.
    if (this._suppressMenuRequest && pointerActivation) {
      this._suppressMenuRequest = false;
      return;
    }
    this._suppressMenuRequest = false;
    this._openMenu(event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
  };

  private _openMenu(initiator: HTMLElement | null): void {
    if (this._menuOpen) {
      this._closeMenu(true);
      return;
    }
    this._menuInitiator = initiator;
    this._menuOpen = true;
    void this.updateComplete.then(() => {
      if (!this._menuOpen) return;
      this.renderRoot
        .querySelector<HTMLButtonElement>('[data-voice-mode-stop], [data-voice-mode-dismiss], [data-voice-mode-mute]')
        ?.focus();
    });
  }

  private _closeMenu(restoreFocus: boolean): void {
    const initiator = this._menuInitiator;
    this._menuOpen = false;
    this._menuInitiator = null;
    if (!restoreFocus || !initiator?.isConnected) return;
    void this.updateComplete.then(() => initiator.focus({ preventScroll: true }));
  }

  private _onMenuKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this._closeMenu(true);
      return;
    }
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        event.stopPropagation();
        this._dock('left');
        return;
      case 'ArrowRight':
        event.preventDefault();
        event.stopPropagation();
        this._dock('right');
        return;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        this._moveVertical(-0.1);
        return;
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        this._moveVertical(0.1);
        return;
      case 'r':
      case 'R':
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        this._resetPosition();
        return;
      default:
        return;
    }
  };

  private _dock(edge: DockEdge): void {
    this._edge = edge;
    this._placeAtStoredPosition();
    this._persistPosition();
  }

  private _moveVertical(delta: number): void {
    this._vertical = clamp(this._vertical + delta, 0, 1);
    this._placeAtStoredPosition();
    this._persistPosition();
  }

  private _resetPosition = (): void => {
    this._edge = DEFAULT_POSITION.edge;
    this._vertical = DEFAULT_POSITION.vertical;
    this._placeAtStoredPosition();
    this._persistPosition();
  };

  private _stop = (): void => {
    this._closeMenu(false);
    voiceSessionController.stop();
  };

  private _toggleMute = (): void => {
    voiceSessionController.setMuted(!this._session.muted);
  };

  private _dismissError = (): void => {
    this._closeMenu(false);
    voiceSessionController.dismissError();
  };

  private _renderMenu() {
    const snapshot = this._session;
    // Error can still mean a partially allocated backend attachment. Stop is
    // the explicit cleanup/retry path; dismiss only clears the presentation.
    const active = snapshot.state !== 'idle';
    return html`
      <div
        class="menu"
        role="dialog"
        aria-label="Voice mode controls"
        aria-describedby="voice-mode-position-help"
        @keydown="${this._onMenuKeyDown}"
      >
        <div class="menu-heading">Voice mode</div>
        <p class="menu-status" data-voice-mode-status>${statusLabel(snapshot)}</p>
        <div class="menu-actions">
          ${active
            ? html`
                <button class="stop" type="button" data-voice-mode-stop @click="${this._stop}">Stop voice mode</button>
                <button
                  type="button"
                  data-voice-mode-mute
                  title="${snapshot.canMute ? '' : 'Microphone is not ready to mute yet.'}"
                  ?disabled="${!snapshot.canMute}"
                  @click="${this._toggleMute}"
                >${snapshot.muted ? 'Unmute microphone' : 'Mute microphone'}</button>
              `
            : nothing}
          ${snapshot.state === 'error'
            ? html`<button type="button" data-voice-mode-dismiss @click="${this._dismissError}">Dismiss error</button>`
            : nothing}
          <button type="button" data-voice-mode-close @click="${() => this._closeMenu(true)}">Close controls</button>
        </div>
        <p id="voice-mode-position-help" class="menu-help">
          Drag the voice control to move it. Arrow keys dock left or right and move it up or down. Press R or Home to reset.
        </p>
        <div class="dock-actions" aria-label="Voice control position">
          <button type="button" data-voice-mode-dock-left @click="${() => this._dock('left')}">Dock left</button>
          <button type="button" data-voice-mode-dock-right @click="${() => this._dock('right')}">Dock right</button>
          <button type="button" data-voice-mode-move-up @click="${() => this._moveVertical(-0.1)}">Move up</button>
          <button type="button" data-voice-mode-move-down @click="${() => this._moveVertical(0.1)}">Move down</button>
          <button type="button" data-voice-mode-reset @click="${this._resetPosition}">Reset position</button>
        </div>
      </div>
    `;
  }

  override render() {
    const show = visible(this._session);
    return html`
      <div class="safe-insets" aria-hidden="true"></div>
      ${show
        ? html`
            <div
              class="bubble"
              data-voice-mode-bubble
              data-state="${this._session.state}"
              data-muted="${String(this._session.muted)}"
              data-edge="${this._edge}"
              data-menu-up="${String(this._vertical > 0.5)}"
              data-positioned="${String(this._positioned)}"
              data-snapping="${String(this._snapping)}"
              style="left:${this._x}px;top:${this._y}px"
            >
              <mux-voice-mode-button
                class="bubble-main"
                menu-trigger
                .snapshot="${this._session}"
                @pointerdown="${this._onPointerDown}"
                @pointermove="${this._onPointerMove}"
                @pointerup="${this._onPointerUp}"
                @pointercancel="${this._onPointerCancel}"
                @voice-mode-menu-request="${this._onMenuRequest}"
              ></mux-voice-mode-button>
              <span class="status" role="status" aria-live="polite">${statusLabel(this._session)}</span>
              ${this._menuOpen ? this._renderMenu() : nothing}
            </div>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-voice-mode-bubble': MuxVoiceModeBubble;
  }
}