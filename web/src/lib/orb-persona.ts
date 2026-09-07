/**
 * orb-persona — continuous, interruptible state blending for the voice orb.
 *
 * PORTED FROM: AI Elements `Persona` (vercel/ai-elements,
 * packages/elements/src/persona.tsx). A verbatim copy of the upstream source is
 * vendored at docs/research/persona-reference/persona.tsx.
 *
 * The upstream component is React + Rive/WebGL2, so it cannot be dropped into a
 * Lit app. What ports is its *state model*, which is the whole reason its
 * transitions read as continuous. persona.tsx:281-294:
 *
 *     listeningInput.value = state === "listening";
 *     thinkingInput.value  = state === "thinking";
 *     speakingInput.value  = state === "speaking";
 *     asleepInput.value    = state === "asleep";
 *
 * That is deliberately NOT an enum switch. Four *independent* inputs are pushed
 * every render into one state machine that is always running (`autoplay: true`,
 * persona.tsx:257), and `idle` is simply the all-false case — it has no input of
 * its own. Rive then blends between artboard states from wherever the blend
 * currently sits. React never restarts, resets or re-mounts anything; it only
 * moves targets.
 *
 * Three consequences follow from that shape, and they are exactly the three
 * properties a hand-rolled CSS class-swap orb fails to deliver:
 *
 *   1. Nothing is keyed to a state *entry*, so nothing can restart from a base
 *      pose at a state boundary.
 *   2. Because every state's contribution is a weight rather than a mode, a
 *      change mid-blend just moves the targets — the blend continues from its
 *      current position.
 *   3. The machine runs whether or not a transition is in flight, so there is no
 *      "start animation" edge to be discontinuous across.
 *
 * This module reproduces that shape in ~500 lines of DOM-driving TypeScript:
 *
 *   - A weight vector over the states, not an active-state enum. `setState()`
 *     writes targets (1 for the named state, 0 for the rest), same as writing
 *     the four Rive booleans.
 *   - One rAF loop that never stops while mounted, same as `autoplay: true`.
 *   - Every visual scalar is a convex combination Σ wᵢ·PROFILE[i][prop] with
 *     Σw ≡ 1. A convex combination of two profiles can never leave the interval
 *     between them, so a transition provably cannot pass through the idle pose
 *     on its way somewhere else.
 *   - Colour is a layered cross-fade (one tinted layer per state, opacities
 *     driven by the same weights) rather than an interpolated gradient. This is
 *     the layered-artboard approach the Rive files use, and it keeps colour
 *     changes on the compositor.
 *
 * Retargeting: a weight tween stores `from` as the weight's *current* value at
 * the moment the target changes, so an interruption continues from where the
 * animation actually is. See `setState()`.
 *
 * All six transitions share one duration and one easing curve — see TIMING.
 */

export type OrbState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'asleep';

/**
 * Painting order, bottom to top. Also the order of the tint layers, which the
 * normalised painter's-algorithm alpha below depends on being stable.
 */
export const ORB_STATES: readonly OrbState[] = [
  'idle',
  'connecting',
  'listening',
  'thinking',
  'speaking',
  'asleep',
] as const;

/* ── TIMING ─────────────────────────────────────────────────────────────────
 * One duration and one easing curve for every transition (T1 idle→listening,
 * T2 listening→thinking, T3 thinking→speaking, T4 speaking→listening,
 * T5 listening→idle, T6 speaking→idle). Deliberately uniform: a per-state
 * duration table is what makes hand-rolled orbs feel arbitrary, and there is no
 * evidence any one of these six wants a different speed.
 *
 * 420ms / cubic-bezier(0.4, 0, 0.2, 1). Two properties were required of the
 * curve, in this order:
 *
 *   1. Zero velocity at BOTH endpoints. dy/dx is 0 at x=0 and at x=1, so the
 *      value does not merely avoid a positional jump — it leaves rest and
 *      arrives at rest with no visible onset and no visible arrival. A curve
 *      that is continuous in position but starts at high velocity still reads
 *      as a snap, which is the quality being removed here. The decelerate-only
 *      curve cubic-bezier(0.32, 0.72, 0, 1) was tried first and rejected for
 *      exactly this: it leaves rest at 2.25x the average rate and is 78% done a
 *      quarter of the way through, which makes the stated duration a fiction.
 *   2. No overshoot. A spring that passes its target reads as a "pop".
 *
 * The cost, stated plainly: because each retarget restarts from zero velocity,
 * an interruption is continuous in position but not in velocity — there is a
 * momentary hitch at the seam. The alternative (velocity-matched retargeting)
 * buys C-1 continuity there at the price of overshoot risk and a much larger
 * engine. The from-rest case is the one the complaint is about, so it wins.
 *
 * REDUCED_MS is longer and paired with a near-linear curve, because the reduced
 * -motion path cross-fades brightness and colour only (no movement at all) and a
 * cross-fade needs longer to read as deliberate rather than as a flicker.
 */
export const TIMING = {
  /** Duration in ms of every one of the six state transitions. */
  DURATION_MS: 420,
  /** Control points of the shared easing curve. */
  EASING: [0.4, 0, 0.2, 1] as const,
  /** The same curve, in CSS syntax, for any stylesheet that needs to match. */
  EASING_CSS: 'cubic-bezier(0.4, 0, 0.2, 1)',
  /** Duration in ms when prefers-reduced-motion is honoured. */
  REDUCED_MS: 700,
  /** Easing when prefers-reduced-motion is honoured: gentle, near-linear. */
  REDUCED_EASING: [0.4, 0, 0.6, 1] as const,
  REDUCED_EASING_CSS: 'cubic-bezier(0.4, 0, 0.6, 1)',
} as const;

/**
 * What each state looks like at full weight. Every field is a plain number so
 * that a blend is a weighted average — that is what guarantees a transition
 * stays inside the interval between the two states it connects.
 *
 * Note what is NOT here: no durations, no easings, no per-state animation names.
 * A state is a *pose*, never a behaviour. Behaviour lives entirely in TIMING.
 */
export interface OrbProfile {
  /** Base scale of the orb body. */
  coreScale: number;
  /** Amplitude of the organic non-uniform wobble, as a fraction of size. */
  wobbleAmp: number;
  /** Wobble frequency, Hz. */
  wobbleRate: number;
  /** Amplitude of the breathing pulse, as a fraction of size. */
  pulseAmp: number;
  /** Breathing frequency, Hz. */
  pulseRate: number;
  /** Swirl rotation rate, revolutions per second. */
  spinRate: number;
  /** Opacity multiplier for the glow shells. */
  glow: number;
  /** Scale of the glow shells relative to the body. */
  haloScale: number;
  /** Opacity of the expanding listening rings. */
  ringActivity: number;
  /** Steady rotation of the body, degrees. */
  tilt: number;
  /** Opacity of the orb body itself (dims for asleep). */
  bodyAlpha: number;
  /** Opacity of the specular highlights. */
  highlight: number;
}

export const PROFILES: Readonly<Record<OrbState, OrbProfile>> = {
  idle: {
    coreScale: 1.0, wobbleAmp: 0.01, wobbleRate: 0.09,
    pulseAmp: 0.012, pulseRate: 0.18, spinRate: 0.05,
    glow: 0.34, haloScale: 1.0, ringActivity: 0, tilt: 0,
    bodyAlpha: 1, highlight: 0.62,
  },
  connecting: {
    coreScale: 0.96, wobbleAmp: 0.008, wobbleRate: 0.14,
    pulseAmp: 0.01, pulseRate: 0.5, spinRate: 0.16,
    glow: 0.22, haloScale: 0.98, ringActivity: 0, tilt: 0,
    bodyAlpha: 0.94, highlight: 0.5,
  },
  listening: {
    coreScale: 1.05, wobbleAmp: 0.014, wobbleRate: 0.16,
    pulseAmp: 0.022, pulseRate: 0.55, spinRate: 0.11,
    glow: 0.62, haloScale: 1.1, ringActivity: 0.55, tilt: 0,
    bodyAlpha: 1, highlight: 0.78,
  },
  thinking: {
    coreScale: 1.02, wobbleAmp: 0.02, wobbleRate: 0.3,
    pulseAmp: 0.016, pulseRate: 0.9, spinRate: 0.34,
    glow: 0.55, haloScale: 1.04, ringActivity: 0, tilt: -2.5,
    bodyAlpha: 1, highlight: 0.7,
  },
  speaking: {
    coreScale: 1.08, wobbleAmp: 0.018, wobbleRate: 0.24,
    pulseAmp: 0.03, pulseRate: 1.15, spinRate: 0.2,
    glow: 0.74, haloScale: 1.14, ringActivity: 0.18, tilt: 0,
    bodyAlpha: 1, highlight: 0.88,
  },
  asleep: {
    coreScale: 0.9, wobbleAmp: 0.006, wobbleRate: 0.05,
    pulseAmp: 0.008, pulseRate: 0.1, spinRate: 0.02,
    glow: 0.12, haloScale: 0.92, ringActivity: 0, tilt: 0,
    bodyAlpha: 0.72, highlight: 0.4,
  },
};

/** Per-state tint, cross-faded as opacity. Matches theme.ts CHROME_DARK. */
export const TINTS: Readonly<Record<OrbState, string>> = {
  idle: '#7aa2f7',
  connecting: '#565f89',
  listening: '#7aa2f7',
  thinking: '#bb9af7',
  speaking: '#7dcfff',
  asleep: '#414868',
};

/** Frequency of the listening ripple, Hz. Constant so its phase never jumps. */
const RING_RATE = 0.5;

type ProfileKey = keyof OrbProfile;
const PROFILE_KEYS: readonly ProfileKey[] = [
  'coreScale', 'wobbleAmp', 'wobbleRate', 'pulseAmp', 'pulseRate',
  'spinRate', 'glow', 'haloScale', 'ringActivity', 'tilt',
  'bodyAlpha', 'highlight',
] as const;

/**
 * prefers-reduced-motion, in two parts.
 *
 * MOTION_ZERO — every amplitude and every rate goes to zero. Not to the idle
 * profile's value: idle still breathes and still drifts, and ambient motion is
 * motion. Under this setting the orb is perfectly, measurably still.
 *
 * MOTION_IDLE — the static pose fields hold at idle, so states no longer differ
 * in size or angle either.
 *
 * What is left to carry the state change: glow, bodyAlpha, highlight and the
 * colour crossfade. That is a legible change with zero movement — which is what
 * the criterion asks for, as against `animation:none` (a hard cut) or leaving
 * the animation untouched.
 */
const MOTION_ZERO: readonly ProfileKey[] = [
  'wobbleAmp', 'wobbleRate', 'pulseAmp', 'pulseRate', 'spinRate', 'ringActivity',
] as const;
const MOTION_IDLE: readonly ProfileKey[] = ['coreScale', 'haloScale', 'tilt'] as const;

/* ── easing ─────────────────────────────────────────────────────────────── */

/**
 * Solves y for a given x on a cubic Bézier with endpoints (0,0) and (1,1),
 * matching the CSS `cubic-bezier()` definition exactly so the JS-driven curve
 * and the CSS string in TIMING.EASING_CSS describe the same motion.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton-Raphson first; it converges in a couple of steps for sane curves.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return sampleY(t);
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    // Bisection fallback, guaranteed to converge.
    let lo = 0;
    let hi = 1;
    t = x;
    while (lo < hi) {
      const err = sampleX(t);
      if (Math.abs(err - x) < 1e-6) break;
      if (x > err) lo = t;
      else hi = t;
      const next = (lo + hi) / 2;
      if (Math.abs(next - t) < 1e-9) break;
      t = next;
    }
    return sampleY(t);
  };
}

const EASE = cubicBezier(...TIMING.EASING);
const EASE_REDUCED = cubicBezier(...TIMING.REDUCED_EASING);

/* ── sampling ───────────────────────────────────────────────────────────── */

/**
 * Everything the engine computed on a frame. Exposed so a transition can be
 * *measured* rather than asserted — see orb-persona.test.ts and
 * docs/research/voice-orb-mock.html's evidence runner.
 */
export interface OrbSample {
  /** ms timestamp of the frame. */
  t: number;
  /** Per-state blend weight. Always sums to 1. */
  weights: Record<OrbState, number>;
  /** Weighted-average profile — the pose, before oscillators are applied. */
  blend: OrbProfile;
  /** Alpha actually written to each tint layer, bottom to top. */
  tintAlphas: number[];
  /** Scale actually written to the body's transform, oscillators included. */
  renderedScaleX: number;
  renderedScaleY: number;
  /** Rotation actually written to the body's transform, degrees. */
  renderedRotate: number;
  /** Opacity actually written to the glow shells. */
  renderedGlowOpacity: number;
}

export interface OrbPersonaOptions {
  /** Starting state. Default 'idle'. */
  initial?: OrbState;
  /**
   * 'auto' follows the prefers-reduced-motion media query (default);
   * true/false force the setting, which is what the artifact's toggle uses.
   */
  reducedMotion?: boolean | 'auto';
  /** Injectable clock, for tests. Defaults to performance.now. */
  now?: () => number;
  /**
   * Start the rAF loop on construction (default true). Tests set false and
   * drive `tick()` by hand so frames are deterministic.
   */
  autoStart?: boolean;
}

/* ── engine ─────────────────────────────────────────────────────────────── */

interface Layers {
  /** Wrapper carrying glow intensity and halo scale. */
  halos: HTMLElement;
  /** One per state, cross-faded for colour. */
  haloGroups: HTMLElement[];
  body: HTMLElement;
  /** One per state, cross-faded for colour. */
  tints: HTMLElement[];
  swirl: HTMLElement;
  highlights: HTMLElement[];
  rings: HTMLElement[];
  shadow: HTMLElement;
}

export class OrbPersona {
  /** Current blend weights. The analogue of persona.tsx's four Rive booleans. */
  private weights: Record<OrbState, number>;
  /** Weight values at the instant the current tween began. */
  private from: Record<OrbState, number>;
  /** Weight values the current tween is heading for. */
  private target: Record<OrbState, number>;
  private tweenStart = 0;
  private tweenDuration: number;

  /** Continuously integrated phases. Never reset — that is the point. */
  private spinPhase = 0;
  private wobblePhase = 0;
  private pulsePhase = 0;
  private ringPhase = 0;

  private lastFrame: number;
  private rafId: number | null = null;
  private readonly now: () => number;
  private reduced: boolean;
  private reducedPref: boolean | 'auto';
  private mql: MediaQueryList | null = null;
  private layers: Layers;
  private lastSample: OrbSample;
  private currentState: OrbState;

  constructor(root: HTMLElement, opts: OrbPersonaOptions = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.currentState = opts.initial ?? 'idle';
    this.reducedPref = opts.reducedMotion ?? 'auto';
    this.reduced = this.resolveReduced();
    this.tweenDuration = this.reduced ? TIMING.REDUCED_MS : TIMING.DURATION_MS;

    const zero = () => Object.fromEntries(ORB_STATES.map((s) => [s, 0])) as Record<OrbState, number>;
    this.weights = zero();
    this.weights[this.currentState] = 1;
    this.from = { ...this.weights };
    this.target = { ...this.weights };

    this.lastFrame = this.now();
    this.tweenStart = this.lastFrame - this.tweenDuration; // settled

    this.layers = this.build(root);
    this.lastSample = this.computeSample(this.lastFrame);
    this.apply(this.lastSample);
    this.watchMedia();
    if (opts.autoStart !== false) this.start();
  }

  /* — public API ————————————————————————————————————————— */

  /**
   * Push a new target. The direct analogue of persona.tsx:281-294 — this writes
   * targets into an already-running machine, it does not start an animation.
   *
   * `from` is snapshotted from the *live* weights, so calling this mid-blend
   * retargets from wherever the blend currently sits instead of jumping to the
   * previous target first.
   */
  setState(state: OrbState): void {
    if (!ORB_STATES.includes(state)) throw new Error(`unknown orb state: ${state}`);
    this.currentState = state;
    const t = this.now();
    for (const s of ORB_STATES) {
      this.from[s] = this.weights[s];
      this.target[s] = s === state ? 1 : 0;
    }
    this.tweenStart = t;
    this.tweenDuration = this.reduced ? TIMING.REDUCED_MS : TIMING.DURATION_MS;
  }

  get state(): OrbState {
    return this.currentState;
  }

  /** The most recent frame's computed values. */
  sample(): OrbSample {
    return this.lastSample;
  }

  /** Advance the engine by hand. Used by tests; the rAF loop calls it too. */
  tick(t: number = this.now()): OrbSample {
    const dt = Math.min(Math.max((t - this.lastFrame) / 1000, 0), 0.1);
    this.lastFrame = t;
    const s = this.computeSample(t, dt);
    this.lastSample = s;
    this.apply(s);
    return s;
  }

  setReducedMotion(pref: boolean | 'auto'): void {
    this.reducedPref = pref;
    const next = this.resolveReduced();
    if (next === this.reduced) return;
    // Snapshot the blend position under the OLD curve and OLD duration before
    // flipping — progress() reads both, so flipping first would evaluate the
    // outgoing tween against the incoming curve and produce a jump. (This was a
    // real defect; the K5 toggle test caught it.)
    const t = this.now();
    const eased = this.progress(t);
    this.reduced = next;
    for (const s of ORB_STATES) this.from[s] = this.from[s] + (this.target[s] - this.from[s]) * eased;
    this.tweenStart = t;
    this.tweenDuration = this.reduced ? TIMING.REDUCED_MS : TIMING.DURATION_MS;
  }

  get reducedMotion(): boolean {
    return this.reduced;
  }

  destroy(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    this.mql?.removeEventListener('change', this.onMedia);
    this.mql = null;
  }

  /* — internals ————————————————————————————————————————— */

  private resolveReduced(): boolean {
    if (this.reducedPref !== 'auto') return this.reducedPref;
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private onMedia = () => {
    if (this.reducedPref === 'auto') this.setReducedMotion('auto');
  };

  private watchMedia(): void {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    this.mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.mql.addEventListener('change', this.onMedia);
  }

  private start(): void {
    if (typeof requestAnimationFrame !== 'function') return;
    const loop = (t: number) => {
      this.tick(t);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private progress(t: number): number {
    const raw = this.tweenDuration <= 0 ? 1 : (t - this.tweenStart) / this.tweenDuration;
    const clamped = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    return this.reduced ? EASE_REDUCED(clamped) : EASE(clamped);
  }

  private computeSample(t: number, dt = 0): OrbSample {
    const eased = this.progress(t);

    // Weights. Every weight shares one clock and one curve, so Σw is preserved
    // exactly: Σ(fromᵢ + e·(toᵢ − fromᵢ)) = Σfrom + e·(Σto − Σfrom) = 1.
    let total = 0;
    for (const s of ORB_STATES) {
      const w = this.from[s] + (this.target[s] - this.from[s]) * eased;
      this.weights[s] = w;
      total += w;
    }
    if (total > 0 && Math.abs(total - 1) > 1e-9) {
      for (const s of ORB_STATES) this.weights[s] /= total;
    }

    // Pose: a convex combination of the state profiles. Because Σw ≡ 1 and every
    // wᵢ ≥ 0, each field is bounded by the min and max of the contributing
    // states — a transition cannot leave the interval between them, so it cannot
    // dip through the idle pose on the way.
    const blend = {} as OrbProfile;
    for (const key of PROFILE_KEYS) {
      let v = 0;
      for (const s of ORB_STATES) v += this.weights[s] * PROFILES[s][key];
      blend[key] = v;
    }

    if (this.reduced) {
      for (const key of MOTION_ZERO) blend[key] = 0;
      for (const key of MOTION_IDLE) blend[key] = PROFILES.idle[key];
    }

    // Phases integrate rate·dt. The rate itself is a blend, so it is continuous,
    // and integrating it keeps the *angle* C¹-continuous across a transition.
    // Swapping a CSS animation-duration instead — which is what the previous orb
    // did — restarts the angle, which is a visible jump.
    this.spinPhase += blend.spinRate * dt;
    this.wobblePhase += blend.wobbleRate * dt;
    this.pulsePhase += blend.pulseRate * dt;
    this.ringPhase += RING_RATE * dt;

    const TAU = Math.PI * 2;
    const pulse = Math.sin(this.pulsePhase * TAU) * blend.pulseAmp;
    const wob = Math.sin(this.wobblePhase * TAU) * blend.wobbleAmp;
    const wob2 = Math.sin(this.wobblePhase * TAU + 0.37) * blend.wobbleAmp;

    const scaleX = blend.coreScale * (1 + pulse + wob);
    const scaleY = blend.coreScale * (1 + pulse - wob2);
    const rotate = blend.tilt + Math.sin(this.wobblePhase * TAU * 0.5) * 1.2;

    // Normalised painter's algorithm. Painting layer i with alpha wᵢ/Σ_{j≤i} wⱼ
    // over the layers below yields exactly Σ wᵢ·Cᵢ — the same weighted average
    // used for the pose, so colour obeys the same no-snap-through-base bound.
    // Only opacity is touched, so the crossfade stays on the compositor.
    const tintAlphas: number[] = [];
    let cum = 0;
    for (const s of ORB_STATES) {
      const w = this.weights[s];
      cum += w;
      tintAlphas.push(cum > 1e-9 ? w / cum : 0);
    }

    return {
      t,
      weights: { ...this.weights },
      blend,
      tintAlphas,
      renderedScaleX: scaleX,
      renderedScaleY: scaleY,
      renderedRotate: rotate,
      renderedGlowOpacity: blend.glow,
    };
  }

  /**
   * Writes the frame. Only `transform` and `opacity` are ever assigned — no
   * width, height, top, left, border-radius, box-shadow or filter is animated,
   * so no frame can force layout. `filter: blur()` is used by the stylesheet on
   * the halo, swirl and highlight layers, but it is a static value set once and
   * never touched here; those layers are blurred, then moved and faded.
   */
  private apply(s: OrbSample): void {
    const b = s.blend;

    this.layers.body.style.transform =
      `scale(${s.renderedScaleX.toFixed(5)}, ${s.renderedScaleY.toFixed(5)}) rotate(${s.renderedRotate.toFixed(4)}deg)`;
    this.layers.body.style.opacity = b.bodyAlpha.toFixed(5);

    // Colour is a cross-fade of per-state layers, in two places: the opaque body
    // tints and the translucent halo shells. Both use the same alphas, so hue
    // never changes discontinuously anywhere in the stack.
    for (let i = 0; i < this.layers.tints.length; i++) {
      const a = s.tintAlphas[i].toFixed(5);
      this.layers.tints[i].style.opacity = a;
      this.layers.haloGroups[i].style.opacity = a;
    }

    // Glow *intensity* and halo scale ride on the wrapper, so the six colour
    // groups only ever carry the crossfade.
    this.layers.halos.style.opacity = b.glow.toFixed(5);
    this.layers.halos.style.transform =
      `scale(${(b.haloScale * (1 + Math.sin(this.pulsePhase * Math.PI * 2) * b.pulseAmp * 0.6)).toFixed(5)})`;

    this.layers.swirl.style.transform = `rotate(${((this.spinPhase * 360) % 360).toFixed(3)}deg)`;
    this.layers.swirl.style.opacity = (0.18 + b.glow * 0.5).toFixed(5);

    for (const hl of this.layers.highlights) {
      hl.style.opacity = (b.highlight * Number(hl.dataset.depth ?? '1')).toFixed(5);
    }

    for (let i = 0; i < this.layers.rings.length; i++) {
      const frac = (this.ringPhase + i * 0.5) % 1;
      this.layers.rings[i].style.transform = `scale(${(0.86 + frac * 0.62).toFixed(5)})`;
      this.layers.rings[i].style.opacity = (b.ringActivity * (1 - frac) * (1 - frac)).toFixed(5);
    }

    this.layers.shadow.style.opacity = (0.28 + b.glow * 0.22).toFixed(5);
    this.layers.shadow.style.transform = `translateX(-50%) scale(${(0.9 + b.coreScale * 0.1).toFixed(5)}, 1)`;
  }

  /**
   * Builds the layer stack. The engine owns its markup so that the Lit
   * component and the standalone artifact page cannot drift apart.
   */
  private build(root: HTMLElement): Layers {
    root.classList.add('orb-stage');
    root.innerHTML = '';

    const mk = (cls: string, parent: HTMLElement, depth?: number): HTMLElement => {
      const d = document.createElement('div');
      d.className = cls;
      if (depth !== undefined) d.dataset.depth = String(depth);
      parent.appendChild(d);
      return d;
    };

    const shadow = mk('orb-shadow', root);

    const halos = mk('orb-halos', root);
    const haloGroups = ORB_STATES.map((s) => {
      const g = mk('orb-halo-group', halos);
      g.dataset.state = s;
      g.style.setProperty('--tint', TINTS[s]);
      for (const shell of ['orb-halo-4', 'orb-halo-1', 'orb-halo-2', 'orb-halo-3']) {
        mk(`orb-halo ${shell}`, g);
      }
      return g;
    });

    // The rings are deliberately one fixed colour for every state. A ring is a
    // thin, low-alpha stroke; giving it a per-state hue would mean either a
    // discontinuous colour change or six more cross-fade layers for a detail
    // nobody can read. Only its opacity blends.
    const rings = [mk('orb-ring', root), mk('orb-ring', root)];

    const body = mk('orb-body', root);
    const tints = ORB_STATES.map((s) => {
      const el = mk('orb-tint', body);
      el.dataset.state = s;
      el.style.setProperty('--tint', TINTS[s]);
      return el;
    });

    const swirl = mk('orb-swirl', body);
    const highlights = [mk('orb-hl orb-hl-1', body, 1), mk('orb-hl orb-hl-2', body, 1.1)];

    return { halos, haloGroups, body, tints, swirl, highlights, rings, shadow };
  }
}

/**
 * The stylesheet the layer stack needs. Exported as a string so the Lit
 * component and the standalone artifact share one definition.
 *
 * Every value here is static. Nothing in this sheet transitions or animates —
 * all motion comes from OrbPersona.apply() writing transform and opacity. The
 * `filter: blur()` values are set once at build time and never animated.
 */
export const ORB_CSS = `
.orb-stage{
  position:relative;
  width:var(--orb-box,84px);
  height:var(--orb-box,84px);
  display:grid;
  place-items:center;
  flex:0 0 auto;
  isolation:isolate;
}
.orb-stage>*{grid-area:1/1;will-change:transform,opacity}
.orb-shadow{
  position:absolute;bottom:2%;left:50%;
  width:calc(var(--orb-d,62px)*.74);height:calc(var(--orb-d,62px)*.17);
  border-radius:50%;
  background:radial-gradient(ellipse,rgba(0,0,0,.55),transparent 70%);
  filter:blur(calc(var(--orb-d,62px)*.06));
}
.orb-halos{
  position:absolute;width:var(--orb-d,62px);height:var(--orb-d,62px);
  pointer-events:none;
}
.orb-halo-group{position:absolute;inset:0;pointer-events:none}
.orb-halo{
  position:absolute;inset:0;border-radius:50%;pointer-events:none;
}
.orb-halo-1{
  background:radial-gradient(circle,color-mix(in srgb,var(--tint) 46%,transparent) 0%,transparent 62%);
  filter:blur(calc(var(--orb-d,62px)*.22));scale:1.6;
}
.orb-halo-2{
  background:radial-gradient(circle at 40% 38%,color-mix(in srgb,var(--tint) 60%,transparent) 0%,transparent 58%);
  filter:blur(calc(var(--orb-d,62px)*.13));scale:1.32;
}
.orb-halo-3{
  background:radial-gradient(circle at 62% 66%,color-mix(in srgb,#fff 34%,var(--tint)) 0%,transparent 52%);
  filter:blur(calc(var(--orb-d,62px)*.09));scale:1.1;
}
.orb-halo-4{
  background:radial-gradient(circle,color-mix(in srgb,var(--tint) 30%,transparent) 0%,transparent 55%);
  filter:blur(calc(var(--orb-d,62px)*.3));scale:1.8;
}
.orb-ring{
  position:absolute;width:var(--orb-d,62px);height:var(--orb-d,62px);
  border-radius:50%;pointer-events:none;opacity:0;
  border:1px solid color-mix(in srgb,#7aa2f7 52%,transparent);
}
.orb-body{
  position:relative;width:var(--orb-d,62px);height:var(--orb-d,62px);
  border-radius:50%;overflow:hidden;
  background:#080a14;
}
.orb-tint{
  position:absolute;inset:0;border-radius:50%;pointer-events:none;
  background:radial-gradient(circle at 34% 28%,
    color-mix(in srgb,#fff 40%,var(--tint)) 0%,
    var(--tint) 32%,
    color-mix(in srgb,var(--tint) 52%,#080a14) 70%,
    color-mix(in srgb,var(--tint) 14%,#080a14) 100%);
}
.orb-swirl{
  position:absolute;inset:-34%;pointer-events:none;
  background:conic-gradient(from 0deg,transparent 0deg,
    color-mix(in srgb,#fff 30%,transparent) 40deg,transparent 94deg,
    color-mix(in srgb,#fff 60%,transparent) 166deg,transparent 230deg,
    color-mix(in srgb,#fff 20%,transparent) 298deg,transparent 360deg);
  filter:blur(calc(var(--orb-d,62px)*.11));
}
.orb-hl{position:absolute;border-radius:50%;pointer-events:none}
.orb-hl-1{
  left:20%;top:13%;width:36%;height:27%;
  background:radial-gradient(circle,rgba(255,255,255,.62),transparent 66%);
  filter:blur(calc(var(--orb-d,62px)*.055));
}
.orb-hl-2{
  left:29%;top:20%;width:12%;height:9%;
  background:rgba(255,255,255,.92);
  filter:blur(calc(var(--orb-d,62px)*.014));
}
`;
