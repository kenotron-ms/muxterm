/**
 * <mux-voice-orb> — the voice orb as a Lit element.
 *
 * This is the Lit half of the AI Elements `Persona` port. The upstream
 * component is React + Rive/WebGL2 and cannot be used directly here; its state
 * model is reproduced in lib/orb-persona.ts, and this element is the thin
 * wrapper around it — the same role persona.tsx plays for the Rive runtime.
 *
 * The wrapper is deliberately as thin as its upstream counterpart: it owns no
 * animation state, starts nothing and stops nothing on a state change. It sets
 * `state` on an engine that is always running, exactly as persona.tsx pushes
 * boolean inputs into an always-playing Rive state machine.
 *
 * WHERE THE ANIMATION IS: not here. This file holds no animation logic at all,
 * by design and in imitation of upstream — persona.tsx holds none either,
 * because the animation lives in the Rive runtime behind it. The engine is
 * lib/orb-persona.ts; `computeSample()` is the weight tween, the convex
 * combination, and the normalised painter's alpha. Reading this file alone and
 * concluding the technique is absent is like reading persona.tsx alone and
 * concluding Rive does not blend.
 *
 * There is no CSS animation, CSS transition or @keyframes anywhere in the port.
 * `node docs/research/voice-orb-evidence.mjs --technique` proves it at runtime:
 * document.getAnimations() is 0 while the orb is moving, and the weight vector
 * recovered from measured layer opacities sums to 1 on every frame.
 *
 * Not yet mounted anywhere in the app — integrating the orb into the live chat
 * surface is separate work. This exists so the port is a real, typechecked Lit
 * component rather than a claim, and so the standalone artifact at
 * docs/research/voice-orb-mock.html has something to be the preview *of*.
 */

import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { createRef, ref, type Ref } from 'lit/directives/ref.js';
import { OrbPersona, ORB_CSS, type OrbState } from '../lib/orb-persona.js';

@customElement('mux-voice-orb')
export class MuxVoiceOrb extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      --orb-box: 84px;
      --orb-d: 62px;
    }
    ${unsafeCSS(ORB_CSS)}
  `;

  /** Current conversational state. Written straight through to the engine. */
  @property({ type: String }) state: OrbState = 'idle';

  /**
   * 'auto' (default) follows prefers-reduced-motion. Explicit true/false is for
   * previews that need to demonstrate the reduced-motion path on demand.
   */
  @property({ attribute: 'reduced-motion' }) reducedMotion: boolean | 'auto' = 'auto';

  private stageRef: Ref<HTMLDivElement> = createRef();
  private engine: OrbPersona | null = null;

  firstUpdated(): void {
    const el = this.stageRef.value;
    if (!el) return;
    this.engine = new OrbPersona(el, { initial: this.state, reducedMotion: this.reducedMotion });
  }

  updated(changed: Map<string, unknown>): void {
    if (!this.engine) return;
    // No restart, no reset: only targets move. This single line is the whole
    // behavioural contract inherited from persona.tsx:281-294.
    if (changed.has('state')) this.engine.setState(this.state);
    if (changed.has('reducedMotion')) this.engine.setReducedMotion(this.reducedMotion);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.engine?.destroy();
    this.engine = null;
  }

  /** Live engine readout, for tests and the artifact's evidence runner. */
  get persona(): OrbPersona | null {
    return this.engine;
  }

  render() {
    return html`<div ${ref(this.stageRef)}></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-voice-orb': MuxVoiceOrb;
  }
}
