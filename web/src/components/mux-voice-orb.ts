/**
 * <mux-voice-orb> — the visual state of a spoken conversation.
 *
 * A LEAF. Two inputs, `state` and `level`, and nothing else: no store, no
 * socket, no controller import, no knowledge that a realtime session exists.
 * That is what makes it renderable in a test, in a mock, and in the composer
 * without dragging a session into any of them.
 *
 *   <mux-voice-orb state="listening" level="0.4"></mux-voice-orb>
 *
 * Zero external dependencies. In particular NOT Persona
 * (elements.ai-sdk.dev), which is a Rive animation needing a 2.15 MB WASM
 * runtime fetched from a public CDN — incompatible with a single binary that
 * serves embedded assets, often over a tunnel, on a machine that may have no
 * route to that CDN. Its state model was adopted; the art is CSS.
 *
 * All motion is written by orb-persona.ts as transform and opacity only. No
 * value in the stylesheet below transitions or animates, and the blur()
 * values are set once and never touched per frame — a blur re-evaluated
 * every frame is the difference between this being free and this pinning a
 * core.
 *
 * The stylesheet between the @orb-css markers is lifted from the UX mock at
 * docs/research/voice-orb-mock.html (branch research/realtime-voice).
 */

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { OrbPersona, type OrbState } from '../lib/orb-persona.js';

@customElement('mux-voice-orb')
export class MuxVoiceOrb extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      /* Sized by the caller. --orb-box is the layout box, --orb-d the
         sphere itself; the halos deliberately overflow the sphere. */
      width: var(--orb-box, 84px);
      height: var(--orb-box, 84px);
      contain: layout paint;
    }

    /* ═══ ORB — every value below is static. Nothing here transitions or
       animates; all motion is written by the engine as transform/opacity
       only. The filter: blur() values are set once and never touched per
       frame. ═══ */
    /* @orb-css:begin */
    .orb-stage {
      position: relative;
      width: var(--orb-box, 84px);
      height: var(--orb-box, 84px);
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      isolation: isolate;
    }
    .orb-stage > * {
      grid-area: 1/1;
      will-change: transform, opacity;
    }
    .orb-shadow {
      position: absolute;
      bottom: 2%;
      left: 50%;
      width: calc(var(--orb-d, 62px) * 0.74);
      height: calc(var(--orb-d, 62px) * 0.17);
      border-radius: 50%;
      background: radial-gradient(ellipse, rgba(0, 0, 0, 0.55), transparent 70%);
      filter: blur(calc(var(--orb-d, 62px) * 0.06));
    }
    .orb-halos {
      position: absolute;
      width: var(--orb-d, 62px);
      height: var(--orb-d, 62px);
      pointer-events: none;
    }
    .orb-halo-group {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .orb-halo {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      pointer-events: none;
    }
    .orb-halo-1 {
      background: radial-gradient(
        circle,
        color-mix(in srgb, var(--tint) 46%, transparent) 0%,
        transparent 62%
      );
      filter: blur(calc(var(--orb-d, 62px) * 0.22));
      scale: 1.6;
    }
    .orb-halo-2 {
      background: radial-gradient(
        circle at 40% 38%,
        color-mix(in srgb, var(--tint) 60%, transparent) 0%,
        transparent 58%
      );
      filter: blur(calc(var(--orb-d, 62px) * 0.13));
      scale: 1.32;
    }
    .orb-halo-3 {
      background: radial-gradient(
        circle at 62% 66%,
        color-mix(in srgb, #fff 34%, var(--tint)) 0%,
        transparent 52%
      );
      filter: blur(calc(var(--orb-d, 62px) * 0.09));
      scale: 1.1;
    }
    .orb-halo-4 {
      background: radial-gradient(
        circle,
        color-mix(in srgb, var(--tint) 30%, transparent) 0%,
        transparent 55%
      );
      filter: blur(calc(var(--orb-d, 62px) * 0.3));
      scale: 1.8;
    }
    .orb-ring {
      position: absolute;
      width: var(--orb-d, 62px);
      height: var(--orb-d, 62px);
      border-radius: 50%;
      pointer-events: none;
      opacity: 0;
      border: 1px solid color-mix(in srgb, #7aa2f7 52%, transparent);
    }
    .orb-body {
      position: relative;
      width: var(--orb-d, 62px);
      height: var(--orb-d, 62px);
      border-radius: 50%;
      overflow: hidden;
      background: #080a14;
    }
    .orb-tint {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      pointer-events: none;
      background: radial-gradient(
        circle at 34% 28%,
        color-mix(in srgb, #fff 40%, var(--tint)) 0%,
        var(--tint) 32%,
        color-mix(in srgb, var(--tint) 52%, #080a14) 70%,
        color-mix(in srgb, var(--tint) 14%, #080a14) 100%
      );
    }
    .orb-swirl {
      position: absolute;
      inset: -34%;
      pointer-events: none;
      background: conic-gradient(
        from 0deg,
        transparent 0deg,
        color-mix(in srgb, #fff 30%, transparent) 40deg,
        transparent 94deg,
        color-mix(in srgb, #fff 60%, transparent) 166deg,
        transparent 230deg,
        color-mix(in srgb, #fff 20%, transparent) 298deg,
        transparent 360deg
      );
      filter: blur(calc(var(--orb-d, 62px) * 0.11));
    }
    .orb-hl {
      position: absolute;
      border-radius: 50%;
      pointer-events: none;
    }
    .orb-hl-1 {
      left: 20%;
      top: 13%;
      width: 36%;
      height: 27%;
      background: radial-gradient(circle, rgba(255, 255, 255, 0.62), transparent 66%);
      filter: blur(calc(var(--orb-d, 62px) * 0.055));
    }
    .orb-hl-2 {
      left: 29%;
      top: 20%;
      width: 12%;
      height: 9%;
      background: rgba(255, 255, 255, 0.92);
      filter: blur(calc(var(--orb-d, 62px) * 0.014));
    }
    /* @orb-css:end */

    /* The engine already stills every moving value and lengthens the blend
       when prefers-reduced-motion is set; this rule only removes the
       compositor hint, since nothing is being promoted for animation any
       more. Deliberately NOT animation:none plus transition:0ms, which would be
       the hard cut that setting is trying to avoid. */
    @media (prefers-reduced-motion: reduce) {
      .orb-stage > * {
        will-change: auto;
      }
    }
  `;

  /** idle · connecting · listening · thinking · speaking · asleep */
  @property({ type: String }) state: OrbState = 'idle';

  /** Live audio level, 0..1. Smoothed by the engine; feed it raw. */
  @property({ type: Number }) level = 0;

  private _orb: OrbPersona | null = null;

  render() {
    return html`<div class="orb-stage" part="stage"></div>`;
  }

  firstUpdated(): void {
    const stage = this.renderRoot.querySelector('.orb-stage');
    if (!(stage instanceof HTMLElement)) return;
    this._orb = new OrbPersona(stage, { initial: this.state });
    this._orb.setLevel(this.level);
  }

  updated(changed: Map<string, unknown>): void {
    if (!this._orb) return;
    // setState writes a TARGET into a loop that is already running. It never
    // restarts anything, so a state change arriving mid-transition — the
    // barge-in case, speaking → listening — picks up from the live pose.
    if (changed.has('state') && this._orb.state !== this.state) this._orb.setState(this.state);
    if (changed.has('level')) this._orb.setLevel(this.level);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    // A rAF loop left running on a detached element is a leak that survives
    // every subsequent open of the surface.
    this._orb?.stop();
    this._orb = null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-voice-orb': MuxVoiceOrb;
  }
}
