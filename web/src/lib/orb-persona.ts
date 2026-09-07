/**
 * orb-persona — the animation engine behind <mux-voice-orb>.
 *
 * WHY THIS IS HAND-WRITTEN AND NOT A DEPENDENCY
 *
 * The obvious component for this job is Persona (elements.ai-sdk.dev). It was
 * evaluated and rejected: it is a Rive animation whose 2.15 MB WASM runtime
 * self-fetches from a public CDN. muxterm is a single binary that serves its
 * own embedded assets and is routinely reached over a tunnel on a machine
 * with no route to that CDN, so a component that phones home for its runtime
 * is not a component muxterm can ship. What was adopted is its STATE MODEL —
 * idle · connecting · listening · thinking · speaking · asleep, with
 * enter → loop → exit phases — and the art was reimplemented in CSS.
 *
 * WHY A WEIGHT VECTOR RATHER THAN A CSS TRANSITION PER STATE
 *
 * Persona pushes four independent booleans into an always-running Rive state
 * machine rather than switching on an enum, and that is what makes its
 * transitions continuous, interruptible, and free of any reset-to-base. The
 * analogue here: every state has a POSE (a set of scalars), the live pose is
 * a convex combination of them under a weight vector, and setState() writes
 * new targets into a loop that never stops. Retargeting mid-transition picks
 * up from the LIVE value, so an interruption — speaking → listening when the
 * user barges in, which is the single most common transition in a real
 * conversation — is smooth rather than a snap.
 *
 * Three properties follow from the convex combination and are worth stating
 * because they are the reason it is written this way:
 *   - Σw is preserved exactly, so the pose is always a real blend.
 *   - The blend is bounded by the states in play, so a transition can never
 *     detour through the idle pose on its way somewhere else.
 *   - Rates integrate into phases, so changing a rate never jumps an angle.
 *
 * Only transform and opacity are ever written, so every frame stays on the
 * compositor. Nothing here uses a CSS transition or keyframe animation.
 *
 * The constants block below is lifted verbatim from the UX mock at
 * docs/research/voice-orb-mock.html (branch research/realtime-voice), which
 * is where the values were tuned; orb-persona.test.ts asserts the two stay
 * in step.
 */

/* @orb-constants:begin */
export const ORB_CONSTANTS = {
  DURATION_MS: 420,
  EASING: [0.4, 0, 0.2, 1],
  REDUCED_MS: 700,
  REDUCED_EASING: [0.4, 0, 0.6, 1],
  STATES: ['idle', 'connecting', 'listening', 'thinking', 'speaking', 'asleep'],
  PROFILES: {
    idle:       { coreScale: 1,    wobbleAmp: 0.01,  wobbleRate: 0.09, pulseAmp: 0.012, pulseRate: 0.18, spinRate: 0.05, glow: 0.34, haloScale: 1,    ringActivity: 0,    tilt: 0,    bodyAlpha: 1,    highlight: 0.62 },
    connecting: { coreScale: 0.96, wobbleAmp: 0.008, wobbleRate: 0.14, pulseAmp: 0.01,  pulseRate: 0.5,  spinRate: 0.16, glow: 0.22, haloScale: 0.98, ringActivity: 0,    tilt: 0,    bodyAlpha: 0.94, highlight: 0.5 },
    listening:  { coreScale: 1.05, wobbleAmp: 0.014, wobbleRate: 0.16, pulseAmp: 0.022, pulseRate: 0.55, spinRate: 0.11, glow: 0.62, haloScale: 1.1,  ringActivity: 0.55, tilt: 0,    bodyAlpha: 1,    highlight: 0.78 },
    thinking:   { coreScale: 1.02, wobbleAmp: 0.02,  wobbleRate: 0.3,  pulseAmp: 0.016, pulseRate: 0.9,  spinRate: 0.34, glow: 0.55, haloScale: 1.04, ringActivity: 0,    tilt: -2.5, bodyAlpha: 1,    highlight: 0.7 },
    speaking:   { coreScale: 1.08, wobbleAmp: 0.018, wobbleRate: 0.24, pulseAmp: 0.03,  pulseRate: 1.15, spinRate: 0.2,  glow: 0.74, haloScale: 1.14, ringActivity: 0.18, tilt: 0,    bodyAlpha: 1,    highlight: 0.88 },
    asleep:     { coreScale: 0.9,  wobbleAmp: 0.006, wobbleRate: 0.05, pulseAmp: 0.008, pulseRate: 0.1,  spinRate: 0.02, glow: 0.12, haloScale: 0.92, ringActivity: 0,    tilt: 0,    bodyAlpha: 0.72, highlight: 0.4 },
  },
  TINTS: {
    idle: '#7aa2f7',
    connecting: '#565f89',
    listening: '#7aa2f7',
    thinking: '#bb9af7',
    speaking: '#7dcfff',
    asleep: '#414868',
  },
} as const;
/* @orb-constants:end */

export type OrbState = (typeof ORB_CONSTANTS.STATES)[number];

type Profile = Record<string, number>;

const STATES = ORB_CONSTANTS.STATES as readonly string[];
const PROFILES = ORB_CONSTANTS.PROFILES as unknown as Record<string, Profile>;
const TINTS = ORB_CONSTANTS.TINTS as unknown as Record<string, string>;
const PROFILE_KEYS = Object.keys(PROFILES.idle);

/**
 * prefers-reduced-motion: every amplitude and rate goes to zero (idle still
 * breathes, and ambient motion is motion), static pose fields hold at idle.
 * What is left to carry the state change is glow, bodyAlpha, highlight and
 * the colour crossfade — legible, with zero movement.
 *
 * Deliberately NOT `animation:none` — a hard cut is a worse answer to
 * reduced-motion than a slower, still one.
 */
const MOTION_ZERO = ['wobbleAmp', 'wobbleRate', 'pulseAmp', 'pulseRate', 'spinRate', 'ringActivity'];
const MOTION_IDLE = ['coreScale', 'haloScale', 'tilt'];
const RING_RATE = 0.5;

/** How hard the live audio level pushes the core. Small on purpose: the orb
 *  reads as breathing with the voice, not as a VU meter. */
const LEVEL_GAIN = 0.16;
/** How fast the smoothed level chases the raw one, per second. A raw RMS
 *  from an AnalyserNode is far too jittery to drive a transform directly. */
const LEVEL_ATTACK = 12;
const LEVEL_RELEASE = 4;

export interface OrbSample {
  t: number;
  weights: Record<string, number>;
  blend: Profile;
  tintAlphas: number[];
  level: number;
  renderedScaleX: number;
  renderedScaleY: number;
  renderedRotate: number;
  renderedGlowOpacity: number;
}

interface OrbLayers {
  halos: HTMLElement;
  haloGroups: HTMLElement[];
  body: HTMLElement;
  tints: HTMLElement[];
  swirl: HTMLElement;
  highlights: HTMLElement[];
  rings: HTMLElement[];
  shadow: HTMLElement;
}

export interface OrbOptions {
  initial?: OrbState;
  reducedMotion?: boolean | 'auto';
  autoStart?: boolean;
  now?: () => number;
}

/** The same cubic-bezier solver the mock uses, with the same control points. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - x;
      if (Math.abs(err) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    while (lo < hi) {
      const err = sx(t);
      if (Math.abs(err - x) < 1e-6) break;
      if (x > err) lo = t;
      else hi = t;
      const next = (lo + hi) / 2;
      if (Math.abs(next - t) < 1e-9) break;
      t = next;
    }
    return sy(t);
  };
}

const EASE = cubicBezier(...(ORB_CONSTANTS.EASING as unknown as [number, number, number, number]));
const EASE_REDUCED = cubicBezier(
  ...(ORB_CONSTANTS.REDUCED_EASING as unknown as [number, number, number, number]),
);

export class OrbPersona {
  private now: () => number;
  private currentState: string;
  private reducedPref: boolean | 'auto';
  private reduced: boolean;
  private tweenDuration: number;

  private weights: Record<string, number>;
  private from: Record<string, number>;
  private target: Record<string, number>;

  private spinPhase = 0;
  private wobblePhase = 0;
  private pulsePhase = 0;
  private ringPhase = 0;
  private lastFrame: number;
  private tweenStart: number;

  private rawLevel = 0;
  private smoothLevel = 0;

  private layers: OrbLayers;
  private lastSample: OrbSample;
  private rafId: number | null = null;
  private mql: MediaQueryList | null = null;

  /** Test seam: called with every computed sample. */
  onFrame: ((s: OrbSample) => void) | null = null;

  constructor(root: HTMLElement, opts: OrbOptions = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.currentState = opts.initial ?? 'idle';
    this.reducedPref = opts.reducedMotion === undefined ? 'auto' : opts.reducedMotion;
    this.reduced = this.resolveReduced();
    this.tweenDuration = this.reduced ? ORB_CONSTANTS.REDUCED_MS : ORB_CONSTANTS.DURATION_MS;

    const zero = () => Object.fromEntries(STATES.map((s) => [s, 0]));
    this.weights = zero();
    this.weights[this.currentState] = 1;
    this.from = { ...this.weights };
    this.target = { ...this.weights };

    this.lastFrame = this.now();
    this.tweenStart = this.lastFrame - this.tweenDuration;

    this.layers = this.build(root);
    this.lastSample = this.computeSample(this.lastFrame, 0);
    this.apply(this.lastSample);

    if (typeof window !== 'undefined' && window.matchMedia) {
      this.mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.mql.addEventListener('change', () => {
        if (this.reducedPref === 'auto') this.setReducedMotion('auto');
      });
    }
    if (opts.autoStart !== false) this.start();
  }

  /**
   * The whole public contract: write targets into a machine that is already
   * running. Nothing starts here, and nothing resets.
   */
  setState(state: string): void {
    if (!STATES.includes(state)) throw new Error('unknown orb state: ' + state);
    this.currentState = state;
    const t = this.now();
    for (const s of STATES) {
      this.from[s] = this.weights[s]; // ← retarget from the LIVE value
      this.target[s] = s === state ? 1 : 0;
    }
    this.tweenStart = t;
    this.tweenDuration = this.reduced ? ORB_CONSTANTS.REDUCED_MS : ORB_CONSTANTS.DURATION_MS;
  }

  /** Live audio level, 0..1. Smoothed internally; feed it raw. */
  setLevel(level: number): void {
    this.rawLevel = Number.isFinite(level) ? Math.min(Math.max(level, 0), 1) : 0;
  }

  get state(): string {
    return this.currentState;
  }

  sample(): OrbSample {
    return this.lastSample;
  }

  setReducedMotion(pref: boolean | 'auto'): void {
    this.reducedPref = pref;
    const next = this.resolveReduced();
    if (next === this.reduced) return;
    // Snapshot under the OLD curve and duration before flipping: progress()
    // reads both, so flipping first evaluates the outgoing tween against the
    // incoming curve and jumps.
    const t = this.now();
    const eased = this.progress(t);
    this.reduced = next;
    for (const s of STATES) this.from[s] = this.from[s] + (this.target[s] - this.from[s]) * eased;
    this.tweenStart = t;
    this.tweenDuration = this.reduced ? ORB_CONSTANTS.REDUCED_MS : ORB_CONSTANTS.DURATION_MS;
  }

  private resolveReduced(): boolean {
    if (this.reducedPref !== 'auto') return this.reducedPref;
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  start(): void {
    if (this.rafId !== null) return;
    if (typeof requestAnimationFrame !== 'function') return;
    const loop = (t: number) => {
      this.tick(t);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
  }

  tick(t: number = this.now()): OrbSample {
    const dt = Math.min(Math.max((t - this.lastFrame) / 1000, 0), 0.1);
    this.lastFrame = t;
    const s = this.computeSample(t, dt);
    this.lastSample = s;
    this.apply(s);
    this.onFrame?.(s);
    return s;
  }

  private progress(t: number): number {
    const raw = this.tweenDuration <= 0 ? 1 : (t - this.tweenStart) / this.tweenDuration;
    const c = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    return this.reduced ? EASE_REDUCED(c) : EASE(c);
  }

  private computeSample(t: number, dt: number): OrbSample {
    const eased = this.progress(t);

    // One clock and one curve for every weight, so Σw is preserved exactly.
    let total = 0;
    for (const s of STATES) {
      const w = this.from[s] + (this.target[s] - this.from[s]) * eased;
      this.weights[s] = w;
      total += w;
    }
    if (total > 0 && Math.abs(total - 1) > 1e-9) for (const s of STATES) this.weights[s] /= total;

    // Convex combination of poses: bounded by the states in play, so a
    // transition cannot detour through the idle pose.
    const blend: Profile = {};
    for (const key of PROFILE_KEYS) {
      let v = 0;
      for (const s of STATES) v += this.weights[s] * PROFILES[s][key];
      blend[key] = v;
    }
    if (this.reduced) {
      for (const key of MOTION_ZERO) blend[key] = 0;
      for (const key of MOTION_IDLE) blend[key] = PROFILES.idle[key];
    }

    // Level tracks with an asymmetric follower: quick to rise so a syllable
    // registers, slow to fall so the orb does not flicker between words.
    const k = this.rawLevel > this.smoothLevel ? LEVEL_ATTACK : LEVEL_RELEASE;
    this.smoothLevel += (this.rawLevel - this.smoothLevel) * Math.min(1, k * dt);
    const level = this.reduced ? 0 : this.smoothLevel;

    // Rates integrate into phases, so changing a rate never jumps an angle.
    this.spinPhase += blend.spinRate * dt;
    this.wobblePhase += blend.wobbleRate * dt;
    this.pulsePhase += blend.pulseRate * dt;
    this.ringPhase += RING_RATE * dt;

    const TAU = Math.PI * 2;
    const pulse = Math.sin(this.pulsePhase * TAU) * blend.pulseAmp;
    const wob = Math.sin(this.wobblePhase * TAU) * blend.wobbleAmp;
    const wob2 = Math.sin(this.wobblePhase * TAU + 0.37) * blend.wobbleAmp;
    const drive = 1 + level * LEVEL_GAIN;
    const scaleX = blend.coreScale * drive * (1 + pulse + wob);
    const scaleY = blend.coreScale * drive * (1 + pulse - wob2);
    const rotate = blend.tilt + Math.sin(this.wobblePhase * TAU * 0.5) * 1.2;

    // Normalised painter's algorithm: alpha_i = w_i / Σ_{j≤i} w_j composites
    // to exactly Σ w_i·C_i, so colour obeys the same bound as the pose — and
    // only opacity is touched, so the crossfade stays on the compositor.
    const tintAlphas: number[] = [];
    let cum = 0;
    for (const s of STATES) {
      const w = this.weights[s];
      cum += w;
      tintAlphas.push(cum > 1e-9 ? w / cum : 0);
    }

    return {
      t,
      weights: { ...this.weights },
      blend,
      tintAlphas,
      level,
      renderedScaleX: scaleX,
      renderedScaleY: scaleY,
      renderedRotate: rotate,
      renderedGlowOpacity: blend.glow,
    };
  }

  /** Only transform and opacity are ever written. */
  private apply(s: OrbSample): void {
    const b = s.blend;
    const L = this.layers;
    L.body.style.transform = `scale(${s.renderedScaleX.toFixed(5)}, ${s.renderedScaleY.toFixed(5)}) rotate(${s.renderedRotate.toFixed(4)}deg)`;
    L.body.style.opacity = b.bodyAlpha.toFixed(5);
    for (let i = 0; i < L.tints.length; i++) {
      const a = s.tintAlphas[i].toFixed(5);
      L.tints[i].style.opacity = a;
      L.haloGroups[i].style.opacity = a;
    }
    L.halos.style.opacity = Math.min(1, b.glow + s.level * 0.2).toFixed(5);
    L.halos.style.transform = `scale(${(b.haloScale * (1 + Math.sin(this.pulsePhase * Math.PI * 2) * b.pulseAmp * 0.6 + s.level * 0.06)).toFixed(5)})`;
    L.swirl.style.transform = `rotate(${((this.spinPhase * 360) % 360).toFixed(3)}deg)`;
    L.swirl.style.opacity = (0.18 + b.glow * 0.5).toFixed(5);
    for (const hl of L.highlights) {
      hl.style.opacity = (b.highlight * Number(hl.dataset.depth || 1)).toFixed(5);
    }
    for (let i = 0; i < L.rings.length; i++) {
      const frac = (this.ringPhase + i * 0.5) % 1;
      L.rings[i].style.transform = `scale(${(0.86 + frac * 0.62).toFixed(5)})`;
      L.rings[i].style.opacity = (b.ringActivity * (1 - frac) * (1 - frac)).toFixed(5);
    }
    L.shadow.style.opacity = (0.28 + b.glow * 0.22).toFixed(5);
    L.shadow.style.transform = `translateX(-50%) scale(${(0.9 + b.coreScale * 0.1).toFixed(5)}, 1)`;
  }

  private build(root: HTMLElement): OrbLayers {
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
    const haloGroups = STATES.map((s) => {
      const g = mk('orb-halo-group', halos);
      g.dataset.state = s;
      g.style.setProperty('--tint', TINTS[s]);
      for (const shell of ['orb-halo-4', 'orb-halo-1', 'orb-halo-2', 'orb-halo-3']) {
        mk('orb-halo ' + shell, g);
      }
      return g;
    });
    const rings = [mk('orb-ring', root), mk('orb-ring', root)];
    const body = mk('orb-body', root);
    const tints = STATES.map((s) => {
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
