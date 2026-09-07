/**
 * orb-persona — the properties that make the orb readable rather than busy.
 *
 * The interesting assertions here are not "does it animate". They are the
 * three invariants of the weight-blend model, because those are what make an
 * interrupted transition look intentional instead of like a glitch:
 *
 *   1. Σw is preserved exactly, so the pose is always a real blend.
 *   2. The blend is BOUNDED by the states in play, so a transition can never
 *      detour through a pose that is not on either end of it.
 *   3. Retargeting picks up from the LIVE value, so an interruption does not
 *      snap.
 *
 * Plus artifact parity with the mock the values were tuned in.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { ORB_CONSTANTS, OrbPersona, cubicBezier, type OrbState } from './orb-persona.js';

/** A clock the test drives, so nothing depends on real time or on rAF. */
function makeOrb(initial: OrbState = 'idle') {
  let now = 1000;
  const root = document.createElement('div');
  const orb = new OrbPersona(root, { initial, autoStart: false, reducedMotion: false, now: () => now });
  return {
    orb,
    root,
    advance(ms: number) {
      now += ms;
      return orb.tick(now);
    },
  };
}

describe('orb-persona', () => {
  it('renders every layer the stylesheet styles, one tint per state', () => {
    const { root } = makeOrb();
    expect(root.classList.contains('orb-stage')).toBe(true);
    expect(root.querySelectorAll('.orb-tint').length).toBe(ORB_CONSTANTS.STATES.length);
    expect(root.querySelectorAll('.orb-halo-group').length).toBe(ORB_CONSTANTS.STATES.length);
    expect(root.querySelector('.orb-body')).toBeTruthy();
    expect(root.querySelector('.orb-swirl')).toBeTruthy();
    expect(root.querySelectorAll('.orb-ring').length).toBe(2);
  });

  it('preserves the weight sum exactly, on every frame of a transition', () => {
    const { orb, advance } = makeOrb('idle');
    orb.setState('speaking');
    for (let i = 0; i < 40; i++) {
      const s = advance(16);
      const total = Object.values(s.weights).reduce((a, b) => a + b, 0);
      expect(Math.abs(total - 1)).toBeLessThan(1e-9);
    }
  });

  it('never detours through a pose outside the transition', () => {
    // idle.coreScale is 1 and speaking.coreScale is 1.08. Every intermediate
    // value must lie between them: a blend that dipped to asleep's 0.9 on
    // the way would read as the orb flinching.
    const { orb, advance } = makeOrb('idle');
    const lo = Math.min(ORB_CONSTANTS.PROFILES.idle.coreScale, ORB_CONSTANTS.PROFILES.speaking.coreScale);
    const hi = Math.max(ORB_CONSTANTS.PROFILES.idle.coreScale, ORB_CONSTANTS.PROFILES.speaking.coreScale);
    orb.setState('speaking');
    for (let i = 0; i < 40; i++) {
      const s = advance(16);
      expect(s.blend.coreScale).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(s.blend.coreScale).toBeLessThanOrEqual(hi + 1e-9);
    }
  });

  it('retargets from the live value, so a barge-in does not snap', () => {
    // speaking → listening interrupted halfway is the most common
    // transition in a real conversation: the user talks over the assistant.
    const { orb, advance } = makeOrb('speaking');
    orb.setState('thinking');
    advance(ORB_CONSTANTS.DURATION_MS / 2);
    const mid = orb.sample();

    orb.setState('listening');
    const firstFrame = advance(16);

    // The pose one frame after the interruption must be close to the pose
    // one frame before it. A reset-to-base would jump.
    const jump = Math.abs(firstFrame.blend.glow - mid.blend.glow);
    expect(jump).toBeLessThan(0.05);
    // And it must genuinely be heading somewhere new.
    const later = advance(ORB_CONSTANTS.DURATION_MS);
    expect(later.weights.listening).toBeGreaterThan(0.99);
  });

  it('integrates rates into phases, so changing a rate never jumps an angle', () => {
    const { orb, advance } = makeOrb('idle');
    advance(500);
    const before = orb.sample().renderedRotate;
    orb.setState('thinking'); // a much faster spin and a tilt
    const after = advance(16).renderedRotate;
    expect(Math.abs(after - before)).toBeLessThan(1);
  });

  it('stills every moving value under prefers-reduced-motion, without a hard cut', () => {
    const root = document.createElement('div');
    let now = 0;
    const orb = new OrbPersona(root, {
      initial: 'idle',
      autoStart: false,
      reducedMotion: true,
      now: () => now,
    });
    orb.setState('speaking');
    now += 100;
    const s = orb.tick(now);
    for (const key of ['wobbleAmp', 'pulseAmp', 'spinRate', 'ringActivity']) {
      expect(s.blend[key]).toBe(0);
    }
    // Colour, glow and alpha still carry the state change...
    expect(s.blend.glow).toBeGreaterThan(ORB_CONSTANTS.PROFILES.idle.glow);
    // ...and the blend is still in progress, not snapped to the endpoint.
    expect(s.weights.speaking).toBeLessThan(1);
  });

  it('drives the core from the audio level, gently and smoothly', () => {
    const { orb, advance } = makeOrb('speaking');
    advance(400);
    const quiet = orb.sample().renderedScaleX;
    orb.setLevel(1);
    advance(16);
    // One frame later it has MOVED but not jumped the whole way: a raw RMS
    // is far too jittery to write straight into a transform.
    const oneFrame = orb.sample().level;
    expect(oneFrame).toBeGreaterThan(0);
    expect(oneFrame).toBeLessThan(0.5);
    advance(500);
    const loud = orb.sample().renderedScaleX;
    expect(loud).toBeGreaterThan(quiet);
    // And gently: a level meter, not a bouncing ball.
    expect(loud / quiet).toBeLessThan(1.3);
  });

  it('rejects a state it does not have a pose for', () => {
    const { orb } = makeOrb();
    expect(() => orb.setState('panicking')).toThrow(/unknown orb state/);
  });

  it('solves the same easing curve the mock does', () => {
    const ease = cubicBezier(...(ORB_CONSTANTS.EASING as unknown as [number, number, number, number]));
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.5); // ease-out shape
  });
});

describe('artifact parity with the UX mock', () => {
  // The values were tuned in docs/research/voice-orb-mock.html on the
  // research branch. That file is not part of this worktree, so this check
  // runs only where it is present -- it exists to catch a drift, not to
  // fail a build that has no mock to compare against.
  const MOCK = process.env.ORB_MOCK_PATH ?? '';

  it.runIf(MOCK && existsSync(MOCK))('constants match the mock byte for byte', () => {
    const html = readFileSync(MOCK, 'utf8');
    const m = html.match(/@orb-constants:begin\s*\*\/\s*const ORB_CONSTANTS = ([\s\S]*?);\s*\/\*\s*@orb-constants:end/);
    expect(m, 'the mock no longer carries an @orb-constants block').toBeTruthy();
    const fromMock = JSON.parse(m![1]);
    expect(JSON.parse(JSON.stringify(ORB_CONSTANTS))).toEqual(fromMock);
  });
});
