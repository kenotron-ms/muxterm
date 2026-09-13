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

interface DropTargetBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface DragState {
  readonly pointerId: number;
  readonly captureTarget: HTMLButtonElement;
  readonly originX: number;
  readonly originY: number;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
}

const PRESENTATION_STORAGE_KEY = '[REDACTED:SECRET]';
const DEFAULT_POSITION: StoredPosition = Object.freeze({ edge: 'right', vertical: 0.56 });
const EDGE_GAP = 12;
const DRAG_THRESHOLD = 6;
const SNAP_DURATION_MS = 160;
const DROP_TARGET_SIZE = 76;
const DROP_TARGET_HIT_PADDING = 18;
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
  if (snapshot.paused || snapshot.state === 'paused') return 'Paused';
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
      z-index: 1;
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

    mux-voice-mode-button.bubble-main {
      --voice-mode-target: 60px;
      --voice-mode-icon-size: 38px;
      touch-action: none;
      flex: none;
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

    .error {
      width: min(180px, calc(100vw - 24px));
      padding: 4px 6px;
      border-radius: 4px;
      background: var(--chrome-bar, #202124);
      color: var(--mux-error, var(--chrome-danger, currentColor));
      font-size: 11px;
      font-weight: 500;
      line-height: 1.25;
      overflow-wrap: anywhere;
      text-align: center;
    }

    .bubble[data-edge='left'] .error {
      transform: translateX(calc((min(180px, 100vw - 24px) - 84px) / 2));
    }

    .bubble[data-edge='right'] .error {
      transform: translateX(calc((84px - min(180px, 100vw - 24px)) / 2));
    }

    .bubble[data-paused='true'] .status {
      color: var(--mux-ok, #22c55e);
    }

    .drop-target {
      position: absolute;
      z-index: 0;
      display: grid;
      place-items: center;
      width: ${DROP_TARGET_SIZE}px;
      height: ${DROP_TARGET_SIZE}px;
      box-sizing: border-box;
      padding: 0;
      border: 2px dashed var(--mux-error, var(--chrome-danger, #ef4444));
      border-radius: 50%;
      background: transparent;
      color: var(--mux-error, var(--chrome-danger, #ef4444));
      font: inherit;
      font-size: 42px;
      font-weight: 400;
      line-height: 1;
      pointer-events: none;
    }

    .drop-target[data-highlighted='true'] {
      background: color-mix(in srgb, var(--mux-error, #ef4444) 16%, transparent);
    }

    .drop-target:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 3px;
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
  @state() private _positioned = false;
  @state() private _snapping = false;
  @state() private _dropVisible = false;
  @state() private _dropHighlighted = false;

  private readonly _storedPosition = restorePosition();
  @state() private _edge: DockEdge = this._storedPosition.edge;
  private _vertical = this._storedPosition.vertical;
  private _x = 0;
  private _y = 0;
  private _drag: DragState | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _positionFrame: number | null = null;
  private _snapTimer: ReturnType<typeof setTimeout> | undefined;
  private _suppressNextClick = false;
  private _visualViewport: VisualViewport | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._liveSession = voiceSessionController.snapshot();
    this._unsubscribe = voiceSessionController.subscribe((snapshot) => {
      if (this.snapshot !== undefined) return;
      const wasVisible = visible(this._session);
      const previous = this._session;
      this._liveSession = snapshot;
      if (!visible(snapshot)) {
        this._endDragOnDisconnect();
      } else if (
        !wasVisible ||
        snapshot.state !== previous.state ||
        snapshot.paused !== previous.paused ||
        snapshot.muted !== previous.muted
      ) {
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
    this._endDragOnDisconnect();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('snapshot') || changed.has('_liveSession')) {
      const previous = changed.get(changed.has('snapshot') ? 'snapshot' : '_liveSession') as
        | VoiceSessionSnapshot
        | undefined;
      if (!visible(this._session)) {
        this._endDragOnDisconnect();
      } else if (
        !previous ||
        previous.state !== this._session.state ||
        previous.paused !== this._session.paused ||
        previous.muted !== this._session.muted
      ) {
        this._queuePosition();
      }
    }
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

  private _dropTargetBounds(): DropTargetBounds {
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const insets = this._safeInsets();
    const minimumTop = top + insets.top + EDGE_GAP;
    const bottom = Math.max(minimumTop + DROP_TARGET_SIZE, top + height - insets.bottom - EDGE_GAP);
    const targetTop = Math.max(minimumTop, bottom - DROP_TARGET_SIZE);
    const targetLeft = left + width / 2 - DROP_TARGET_SIZE / 2;
    return {
      left: targetLeft,
      top: targetTop,
      right: targetLeft + DROP_TARGET_SIZE,
      bottom: targetTop + DROP_TARGET_SIZE,
    };
  }

  private _isOverDropTarget(): boolean {
    const target = this._dropTargetBounds();
    const rect = this._bubble()?.getBoundingClientRect();
    const bubbleWidth = rect?.width || FALLBACK_BUBBLE_WIDTH;
    const bubbleHeight = rect?.height || FALLBACK_BUBBLE_HEIGHT;
    const centerX = this._x + bubbleWidth / 2;
    const centerY = this._y + bubbleHeight / 2;
    return (
      centerX >= target.left - DROP_TARGET_HIT_PADDING &&
      centerX <= target.right + DROP_TARGET_HIT_PADDING &&
      centerY >= target.top - DROP_TARGET_HIT_PADDING &&
      centerY <= target.bottom + DROP_TARGET_HIT_PADDING
    );
  }

  private _applyPosition(): void {
    const bubble = this._bubble();
    if (!bubble) return;
    bubble.style.left = `${this._x}px`;
    bubble.style.top = `${this._y}px`;
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
        this.requestUpdate();
        return;
      }
      this._placeAtStoredPosition();
    });
  };

  private _onViewportChange = (): void => {
    this._queuePosition();
    if (this._dropVisible) this.requestUpdate();
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

  /** A cached/re-attached bubble must never inherit a stale pointer gesture. */
  private _endDragOnDisconnect(): void {
    const drag = this._drag;
    this._drag = null;
    this._dropVisible = false;
    this._dropHighlighted = false;
    this._suppressNextClick = false;
    if (!drag) return;
    try {
      if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // Detach may already have released capture.
    }
  }

  private _commitDragPosition(animate: boolean): void {
    const bounds = this._bounds();
    const rect = this._bubble()?.getBoundingClientRect();
    const bubbleWidth = rect?.width || FALLBACK_BUBBLE_WIDTH;
    this._edge = this._x + bubbleWidth / 2 < bounds.middleX ? 'left' : 'right';
    this._vertical =
      bounds.maxY === bounds.minY ? 0 : clamp((this._y - bounds.minY) / (bounds.maxY - bounds.minY), 0, 1);
    if (this._snapTimer !== undefined) clearTimeout(this._snapTimer);
    this._snapping = animate && !this._reducedMotion();
    this._snapTimer = this._snapping ? setTimeout(() => this._finishSnap(), SNAP_DURATION_MS) : undefined;
    this._placeAtStoredPosition();
    this._persistPosition();
  }

  private _onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (this._drag) return;
    this._suppressNextClick = false;
    const captureTarget = event.composedPath().find(
      (target): target is HTMLButtonElement =>
        target instanceof HTMLButtonElement && target.hasAttribute('data-voice-mode-button'),
    );
    if (!captureTarget) return;
    event.stopPropagation();
    captureTarget.setPointerCapture(event.pointerId);
    this._drag = {
      pointerId: event.pointerId,
      captureTarget,
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
    event.stopPropagation();
    const deltaX = event.clientX - drag.originX;
    const deltaY = event.clientY - drag.originY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      this._dropVisible = true;
    }
    event.preventDefault();
    const bounds = this._bounds();
    this._x = clamp(drag.startX + deltaX, bounds.minX, bounds.maxX);
    this._y = clamp(drag.startY + deltaY, bounds.minY, bounds.maxY);
    this._dropHighlighted = this._isOverDropTarget();
    this._applyPosition();
    this.requestUpdate();
  };

  private _finishPointer = (event: PointerEvent, cancelled: boolean): void => {
    const drag = this._drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const shouldExit = drag.moved && !cancelled && this._isOverDropTarget();
    this._drag = null;
    this._dropVisible = false;
    this._dropHighlighted = false;
    if (drag.moved || cancelled) event.preventDefault();
    if (drag.captureTarget.hasPointerCapture(event.pointerId)) {
      drag.captureTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      // A pointer drag must never activate the native button's click. The
      // custom event records pointer activation so keyboard activation remains
      // available even if the browser emitted no compatibility click.
      this._suppressNextClick = true;
      if (shouldExit) {
        voiceSessionController.stop();
      } else {
        this._commitDragPosition(!cancelled);
      }
      return;
    }
    this._suppressNextClick = cancelled;
    if (cancelled) this._queuePosition();
  };

  private _onPointerUp = (event: PointerEvent): void => {
    this._finishPointer(event, false);
  };

  private _onPointerCancel = (event: PointerEvent): void => {
    this._finishPointer(event, true);
  };

  private _onLostPointerCapture = (event: PointerEvent): void => {
    // Losing capture is a cancelled drag, never an exit gesture.
    this._finishPointer(event, true);
  };

  private _onBubbleActivate = (event: Event): void => {
    event.stopPropagation();
    const pointerActivation =
      (event as CustomEvent<{ pointerActivation?: boolean }>).detail?.pointerActivation === true;
    if (this._suppressNextClick && pointerActivation) {
      this._suppressNextClick = false;
      return;
    }
    this._suppressNextClick = false;
    if (this._session.state === 'error') {
      void voiceSessionController.start();
    } else {
      void voiceSessionController.togglePaused();
    }
  };

  private _onBubbleKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        event.stopPropagation();
        voiceSessionController.stop();
        return;
      case 'Escape':
        event.stopPropagation();
        if (this._drag) {
          event.preventDefault();
          this._cancelDrag();
        }
        return;
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
      default:
        return;
    }
  };

  private _cancelDrag(): void {
    const drag = this._drag;
    if (!drag) return;
    this._drag = null;
    this._dropVisible = false;
    this._dropHighlighted = false;
    this._suppressNextClick = true;
    try {
      if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // The browser already released capture.
    }
    if (drag.moved) this._commitDragPosition(false);
    else this._queuePosition();
  }

  private _onDropTargetClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    this._cancelDrag();
    voiceSessionController.stop();
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

  override render() {
    const snapshot = this._session;
    const show = visible(snapshot);
    const dropTarget = this._dropTargetBounds();
    return html`
      <div class="safe-insets" aria-hidden="true"></div>
      ${this._dropVisible && show
        ? html`
            <button
              class="drop-target"
              type="button"
              data-voice-mode-exit-target
              data-highlighted="${String(this._dropHighlighted)}"
              aria-label="Exit voice mode"
              style="left:${dropTarget.left}px;top:${dropTarget.top}px"
              @click="${this._onDropTargetClick}"
            ><span aria-hidden="true">×</span></button>
          `
        : nothing}
      ${show
        ? html`
            <div
              class="bubble"
              data-voice-mode-bubble
              data-state="${snapshot.state}"
              data-paused="${String(snapshot.paused || snapshot.state === 'paused')}"
              data-muted="${String(snapshot.muted)}"
              data-edge="${this._edge}"
              data-positioned="${String(this._positioned)}"
              data-snapping="${String(this._snapping)}"
              style="left:${this._x}px;top:${this._y}px"
            >
              <mux-voice-mode-button
                class="bubble-main"
                bubble-variant
                .snapshot="${snapshot}"
                @pointerdown="${this._onPointerDown}"
                @pointermove="${this._onPointerMove}"
                @pointerup="${this._onPointerUp}"
                @pointercancel="${this._onPointerCancel}"
                @lostpointercapture="${this._onLostPointerCapture}"
                @keydown="${this._onBubbleKeyDown}"
                @voice-mode-bubble-activate="${this._onBubbleActivate}"
              ></mux-voice-mode-button>
              <span class="status" role="status" aria-live="polite">${statusLabel(snapshot)}</span>
              ${snapshot.state === 'error' && snapshot.error
                ? html`<span class="error" role="alert">${snapshot.error}</span>`
                : nothing}
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