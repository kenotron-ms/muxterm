// @vitest-environment happy-dom
/**
 * Measured evidence for the orb's transition criteria.
 *
 * These are not "the code looks right" assertions. Each test drives the real
 * engine frame by frame at 60fps, records the value of every animated scalar on
 * every frame, and asserts a property of the recorded series. The same series is
 * what the browser evidence runner in docs/research/voice-orb-mock.html reads
 * back out of getComputedStyle.
 *
 * K1 no discontinuous jump      — bounded per-frame delta across the series
 * K2 no snap-through-base       — every sample inside the interval [from, to]
 * K3 interruptible              — retarget is continuous and does not complete
 *                                 the outgoing transition first
 * K5 reduced motion             — motion stilled, state change still legible
 * K6 duration and easing stated — one duration, one curve, all six transitions
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OrbPersona,
  PROFILES,
  ORB_STATES,
  TINTS,
  TIMING,
  cubicBezier,
  type OrbState,
  type OrbProfile,
  type OrbSample,
} from './orb-persona.js';

const FRAME = 1000 / 60;

/** Repo targets ES2021; Array.prototype.at is ES2022. */
const last = <T,>(xs: T[]): T => xs[xs.length - 1];

/** The six transitions under test. Closed list. */
const TRANSITIONS: ReadonlyArray<readonly [string, OrbState, OrbState]> = [
  ['T1 idle→listening', 'idle', 'listening'],
  ['T2 listening→thinking', 'listening', 'thinking'],
  ['T3 thinking→speaking', 'thinking', 'speaking'],
  ['T4 speaking→listening', 'speaking', 'listening'],
  ['T5 listening→idle', 'listening', 'idle'],
  ['T6 speaking→idle', 'speaking', 'idle'],
];

/** Scalars whose continuity is asserted. */
const MEASURED = [
  'coreScale', 'glow', 'haloScale', 'ringActivity',
  'spinRate', 'pulseRate', 'bodyAlpha', 'highlight', 'tilt',
] as const;

interface Rig {
  orb: OrbPersona;
  advance: (ms: number) => OrbSample[];
  root: HTMLElement;
}

function rig(initial: OrbState, reducedMotion: boolean | 'auto' = false): Rig {
  const root = document.createElement('div');
  document.body.appendChild(root);
  let clock = 1000;
  const orb = new OrbPersona(root, {
    initial,
    reducedMotion,
    autoStart: false,
    now: () => clock,
  });
  const advance = (ms: number): OrbSample[] => {
    const out: OrbSample[] = [];
    const end = clock + ms;
    while (clock < end) {
      clock = Math.min(clock + FRAME, end);
      out.push(structuredClone(orb.tick(clock)));
    }
    return out;
  };
  // Settle the idle oscillators so the starting pose is a real running frame,
  // not a construction artefact.
  advance(500);
  return { orb, advance, root };
}

const series = (frames: OrbSample[], key: keyof OrbProfile) => frames.map((f) => f.blend[key]);
const maxStep = (xs: number[]) =>
  xs.slice(1).reduce((m, v, i) => Math.max(m, Math.abs(v - xs[i])), 0);

describe('K6 — duration and easing are stated and uniform', () => {
  it('names one duration and one easing curve for all six transitions', () => {
    expect(TIMING.DURATION_MS).toBe(420);
    expect(TIMING.EASING).toEqual([0.4, 0, 0.2, 1]);
    expect(TIMING.EASING_CSS).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
    // Uniform by construction: the engine reads DURATION_MS for every state, so
    // there is no per-state duration table that could drift.
    const src = readFileSync(resolve(__dirname, 'orb-persona.ts'), 'utf8');
    const profileBlock = src.slice(src.indexOf('export const PROFILES'), src.indexOf('export const TINTS'));
    expect(profileBlock).not.toMatch(/duration|easing|cubic-bezier|ms\b/i);
  });

  it('the JS easing curve matches the CSS cubic-bezier definition', () => {
    const ease = cubicBezier(...TIMING.EASING);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    // Monotone and bounded: no overshoot anywhere in the curve.
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.01) {
      const y = ease(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(1 + 1e-9);
      prev = y;
    }
  });

  it('leaves rest and arrives at rest with zero velocity', () => {
    // This is the property that separates "continuous" from "subtle". A curve
    // can be continuous in position and still snap, if it leaves rest fast.
    const ease = cubicBezier(...TIMING.EASING);
    const h = 1e-4;
    expect((ease(h) - ease(0)) / h).toBeLessThan(0.05);
    expect((ease(1) - ease(1 - h)) / h).toBeLessThan(0.05);
    // For contrast, the decelerate-only curve that was rejected:
    const rejected = cubicBezier(0.32, 0.72, 0, 1);
    expect((rejected(h) - rejected(0)) / h).toBeGreaterThan(2);
    // Same for the reduced-motion curve.
    const red = cubicBezier(...TIMING.REDUCED_EASING);
    expect((red(h) - red(0)) / h).toBeLessThan(0.05);
    expect((red(1) - red(1 - h)) / h).toBeLessThan(0.05);
  });
});

describe.each(TRANSITIONS)('%s', (_name, a, b) => {
  it('K1 — every animated scalar moves continuously, no instantaneous change', () => {
    const r = rig(a);
    r.orb.setState(b);
    const frames = r.advance(TIMING.DURATION_MS + 100);

    for (const key of MEASURED) {
      const xs = series(frames, key);
      const range = Math.abs(PROFILES[b][key] - PROFILES[a][key]);
      if (range < 1e-9) continue;
      // A discontinuous change covers the whole range in one frame. At 60fps
      // over 420ms the steepest eased frame is ~10% of range; 25% is a wide
      // margin that still fails hard on any jump.
      expect(maxStep(xs) / range).toBeLessThan(0.25);
      // And it actually arrives.
      expect(last(xs)).toBeCloseTo(PROFILES[b][key], 4);
    }
  });

  it('K2 — stays inside the interval between the two states, never through base', () => {
    const r = rig(a);
    const before = r.orb.sample().blend;
    r.orb.setState(b);
    const frames = r.advance(TIMING.DURATION_MS);

    for (const key of MEASURED) {
      const lo = Math.min(before[key], PROFILES[b][key]) - 1e-9;
      const hi = Math.max(before[key], PROFILES[b][key]) + 1e-9;
      for (const f of frames) {
        expect(f.blend[key]).toBeGreaterThanOrEqual(lo);
        expect(f.blend[key]).toBeLessThanOrEqual(hi);
      }
    }

    // The strong form: the outgoing state's weight decreases monotonically and
    // the incoming state's increases. No third state is ever recruited, so the
    // blend cannot detour through idle (or anything else) on the way.
    for (const s of ORB_STATES) {
      if (s === a || s === b) continue;
      for (const f of frames) expect(f.weights[s]).toBeCloseTo(0, 9);
    }
    const wa = frames.map((f) => f.weights[a]);
    const wb = frames.map((f) => f.weights[b]);
    for (let i = 1; i < frames.length; i++) {
      expect(wa[i]).toBeLessThanOrEqual(wa[i - 1] + 1e-9);
      expect(wb[i]).toBeGreaterThanOrEqual(wb[i - 1] - 1e-9);
    }
    // Weights always partition unity — this is what makes the bound above hold.
    for (const f of frames) {
      const total = ORB_STATES.reduce((n, s) => n + f.weights[s], 0);
      expect(total).toBeCloseTo(1, 9);
    }
  });

  it('K3 — a state change mid-transition retargets from the current value', () => {
    const r = rig(a);
    r.orb.setState(b);
    // A third of the way in. The curve is ~50% resolved there, so the interrupt
    // genuinely lands mid-flight.
    const first = r.advance(TIMING.DURATION_MS / 3);
    const atInterrupt = last(first);

    // Interrupt with a third state, chosen to differ from both.
    const c: OrbState = b === 'thinking' ? 'asleep' : 'thinking';
    r.orb.setState(c);
    const after = r.advance(TIMING.DURATION_MS + 100);

    for (const key of MEASURED) {
      const joined = [...first.map((f) => f.blend[key]), ...after.map((f) => f.blend[key])];
      const span = Math.max(...joined) - Math.min(...joined);
      if (span < 1e-9) continue;
      // Continuous across the seam: the retarget frame is not a jump.
      expect(Math.abs(after[0].blend[key] - atInterrupt.blend[key]) / span).toBeLessThan(0.25);
      // And continuous over the whole joined series.
      expect(maxStep(joined) / span).toBeLessThan(0.25);
      // It resolves to the new target, not the abandoned one.
      expect(last(after).blend[key]).toBeCloseTo(PROFILES[c][key], 4);
    }

    // The abandoned transition was never completed: at the moment of interrupt
    // the incoming weight was strictly between 0 and 1, and from there it falls.
    expect(atInterrupt.weights[b]).toBeGreaterThan(0.05);
    expect(atInterrupt.weights[b]).toBeLessThan(0.9);
    expect(last(after).weights[b]).toBeCloseTo(0, 6);
  });
});

describe('K3 — repeated interruption never accumulates a jump', () => {
  it('survives a state change every 60ms for two seconds', () => {
    const r = rig('idle');
    const order: OrbState[] = ['listening', 'thinking', 'speaking', 'listening', 'idle', 'speaking'];
    const all: OrbSample[] = [];
    for (let i = 0; i < 33; i++) {
      r.orb.setState(order[i % order.length]);
      all.push(...r.advance(60));
    }
    for (const key of MEASURED) {
      const xs = all.map((f) => f.blend[key]);
      // Denominator is the full achievable range of the field across every
      // state — the distance a discontinuous change could cover in one frame.
      // Normalising by the observed span instead would punish a series that
      // simply never travelled far, which is not what K1 is about.
      const reachable = ORB_STATES.map((s) => PROFILES[s][key]);
      const range = Math.max(...reachable) - Math.min(...reachable);
      if (range < 1e-9) continue;
      expect(maxStep(xs) / range).toBeLessThan(0.25);
    }
    // Weights stay a valid partition throughout the storm.
    for (const f of all) {
      let total = 0;
      for (const s of ORB_STATES) {
        expect(f.weights[s]).toBeGreaterThanOrEqual(-1e-9);
        expect(f.weights[s]).toBeLessThanOrEqual(1 + 1e-9);
        total += f.weights[s];
      }
      expect(total).toBeCloseTo(1, 9);
    }
  });
});

describe('K4 — only transform and opacity are written per frame', () => {
  it('touches no layout- or paint-triggering property', () => {
    const r = rig('idle');
    r.orb.setState('speaking');
    r.advance(TIMING.DURATION_MS);

    const touched = new Set<string>();
    for (const el of Array.from(r.root.querySelectorAll<HTMLElement>('*'))) {
      for (let i = 0; i < el.style.length; i++) touched.add(el.style[i]);
    }
    // --tint is a static custom property written once at build time, not a
    // per-frame animation.
    touched.delete('--tint');
    expect([...touched].sort()).toEqual(['opacity', 'transform']);
  });

  it('animates no property from the forbidden set anywhere in the module', () => {
    const src = readFileSync(resolve(__dirname, 'orb-persona.ts'), 'utf8');
    const apply = src.slice(src.indexOf('private apply('), src.indexOf('private build('));
    for (const banned of ['width', 'height', 'top', 'left', 'filter', 'boxShadow', 'borderRadius', 'background']) {
      expect(apply).not.toMatch(new RegExp(`style\\.${banned}\\s*=`));
    }
    // The stylesheet declares no transition and no keyframe animation at all:
    // every moving value comes from apply(), so CSS cannot introduce a cut.
    const cssBlock = src.slice(src.indexOf('export const ORB_CSS'));
    expect(cssBlock).not.toMatch(/transition\s*:/);
    expect(cssBlock).not.toMatch(/@keyframes/);
    expect(cssBlock).not.toMatch(/animation\s*:/);
  });
});

describe('K5 — prefers-reduced-motion', () => {
  it('stills all movement but still changes state legibly', () => {
    const r = rig('speaking', true);
    const before = r.orb.sample().blend;
    r.orb.setState('listening');
    const frames = r.advance(TIMING.REDUCED_MS + 100);

    // Not an unchanged animation: nothing moves at all. Every amplitude and
    // rate is zero, and the rendered transform is bit-for-bit constant across
    // the whole transition.
    for (const f of frames) {
      expect(f.blend.pulseAmp).toBe(0);
      expect(f.blend.wobbleAmp).toBe(0);
      expect(f.blend.spinRate).toBe(0);
      expect(f.blend.ringActivity).toBe(0);
      expect(f.blend.coreScale).toBeCloseTo(PROFILES.idle.coreScale, 12);
      expect(f.blend.tilt).toBeCloseTo(PROFILES.idle.tilt, 12);
      expect(f.renderedScaleX).toBeCloseTo(frames[0].renderedScaleX, 12);
      expect(f.renderedScaleY).toBeCloseTo(frames[0].renderedScaleY, 12);
      expect(f.renderedRotate).toBeCloseTo(frames[0].renderedRotate, 12);
    }

    // Not a hard cut either: brightness and colour interpolate, over the longer
    // reduced-motion duration, with more than a handful of distinct values.
    const glow = frames.map((f) => f.blend.glow);
    expect(glow[0]).toBeCloseTo(before.glow, 3);
    expect(last(glow)).toBeCloseTo(PROFILES.listening.glow, 4);
    expect(new Set(glow.map((g) => g.toFixed(4))).size).toBeGreaterThan(20);
    expect(maxStep(glow) / Math.abs(PROFILES.listening.glow - before.glow)).toBeLessThan(0.25);

    // The colour crossfade is what carries the state identity, and it is still
    // a crossfade rather than a swap.
    const li = ORB_STATES.indexOf('listening');
    const alphas = frames.map((f) => f.tintAlphas[li]);
    expect(maxStep(alphas)).toBeLessThan(0.25);
    expect(last(alphas)).toBeCloseTo(1, 4);
  });

  it('takes the longer reduced duration, not the standard one', () => {
    const r = rig('idle', true);
    r.orb.setState('speaking');
    const atStandardDuration = last(r.advance(TIMING.DURATION_MS));
    expect(atStandardDuration.weights.speaking).toBeLessThan(0.99);
    const done = last(r.advance(TIMING.REDUCED_MS));
    expect(done.weights.speaking).toBeCloseTo(1, 6);
  });

  it('toggling reduced motion mid-transition does not jump the blend', () => {
    // The motion fields drop to still the instant the preference flips — that
    // is the point of the preference, and a preference flip is not one of the
    // six transitions. What must not jump is the blend position itself, which
    // is what carries the state identity. Regression guard for the ordering bug
    // in setReducedMotion(): evaluating the outgoing tween against the incoming
    // easing curve moved glow by half its range in one frame.
    const r = rig('idle', false);
    r.orb.setState('speaking');
    const before = r.advance(200);
    r.orb.setReducedMotion(true);
    const after = r.advance(TIMING.REDUCED_MS);
    for (const key of ['glow', 'bodyAlpha', 'highlight'] as const) {
      const joined = [...before.map((f) => f.blend[key]), ...after.map((f) => f.blend[key])];
      const span = Math.max(...joined) - Math.min(...joined);
      if (span < 1e-9) continue;
      expect(maxStep(joined) / span).toBeLessThan(0.25);
    }
  });
});

describe('artifact parity', () => {
  it('docs/research/voice-orb-mock.html carries the same constants as this module', () => {
    const html = readFileSync(
      resolve(__dirname, '../../../docs/research/voice-orb-mock.html'),
      'utf8',
    );
    const m = html.match(/\/\* @orb-constants:begin \*\/\s*const ORB_CONSTANTS\s*=\s*(\{[\s\S]*?\});\s*\/\* @orb-constants:end \*\//);
    expect(m, 'artifact must expose an @orb-constants block').toBeTruthy();
    const parsed = JSON.parse(m![1]) as {
      DURATION_MS: number;
      EASING: number[];
      REDUCED_MS: number;
      REDUCED_EASING: number[];
      STATES: string[];
      PROFILES: Record<string, OrbProfile>;
      TINTS: Record<string, string>;
    };
    expect(parsed.DURATION_MS).toBe(TIMING.DURATION_MS);
    expect(parsed.EASING).toEqual([...TIMING.EASING]);
    expect(parsed.REDUCED_MS).toBe(TIMING.REDUCED_MS);
    expect(parsed.REDUCED_EASING).toEqual([...TIMING.REDUCED_EASING]);
    expect(parsed.STATES).toEqual([...ORB_STATES]);
    expect(parsed.PROFILES).toEqual(PROFILES);
    expect(parsed.TINTS).toEqual(TINTS);
  });
});
