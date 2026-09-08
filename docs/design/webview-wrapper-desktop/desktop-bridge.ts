/**
 * muxterm desktop wrapper -- WEB-SIDE HALF OF THE BRIDGE.
 *
 * Design artefact. NOT wired into web/src. Changing the muxterm web app is out
 * of scope for this design; this file exists so the contract in bridge.d.ts is
 * a real, type-checked thing rather than prose, and so the eventual one-line
 * call site in web/src/app.ts is obvious.
 *
 * Everything here is deliberately boring:
 *   - it does nothing at all in a browser tab
 *   - it never throws into the app
 *   - it holds no state of its own beyond "what did I last tell native"
 *   - it can be deleted and the web app is unchanged
 *
 * That last property is the test of whether the boundary in D3 held.
 */

import type { DesktopCommand, MuxtermDesktop, VoiceStateDeclaration } from './bridge.js';

/** The bridge contract version this file implements. */
const BRIDGE_VERSION = 1;

/**
 * Exactly what the shim needs from the voice session controller, and no more.
 *
 * web/src/lib/voice-session-controller.ts's exported `voiceSessionController`
 * already satisfies this structurally -- `toggle`, `stop`, `isActive` and
 * `subscribe` are all on it today. Naming it as a narrow interface here rather
 * than importing the module keeps the dependency one-directional: the bridge
 * knows about voice, voice knows nothing about the bridge.
 */
export interface VoiceControl {
  toggle(): Promise<void>;
  stop(): void;
  isActive(): boolean;
  subscribe(cb: (snapshot: { state: string }) => void): () => void;
}

/**
 * Install the page's half of the bridge.
 *
 * Returns a teardown function. Returns a no-op teardown when not running
 * inside the wrapper, which is the common case -- most muxterm users are in a
 * browser tab and this function must be invisible to them.
 */
export function installDesktopBridge(voice: VoiceControl): () => void {
  const host = typeof window === 'undefined' ? undefined : window.__muxtermHost;

  // Not wrapped. This is the normal path.
  if (!host) return () => {};

  if (host.bridge !== BRIDGE_VERSION) {
    // A wrapper older or newer than this page. Refuse to bridge rather than
    // guess at a contract. The web app keeps working; only the tray and the
    // global shortcut go dead, which is exactly the right failure: the
    // wrapper's job is to ADD capability, so losing it must subtract nothing.
    console.warn(
      `[muxterm] desktop bridge version mismatch: host=${host.bridge} page=${BRIDGE_VERSION}; bridge disabled`,
    );
    return () => {};
  }

  // ---------------------------------------------------------------------
  // native -> web: two verbs, no payload
  // ---------------------------------------------------------------------

  const api: MuxtermDesktop = {
    bridge: BRIDGE_VERSION,
    command(verb: DesktopCommand): void {
      switch (verb) {
        case 'voice.toggle':
          // Fire and forget. The orb owns the UI consequences; native is told
          // what happened through declareVoiceState, not through a return value.
          void voice.toggle().catch(() => {
            /* the composer already surfaces voice errors; do not double-report */
          });
          return;
        case 'voice.stop':
          voice.stop();
          return;
        default:
          // Unreachable given the closed type, but native builds the eval
          // string, and a wrapper newer than this page could invent a verb.
          console.warn('[muxterm] unknown desktop command', verb);
          return;
      }
    },
  };

  window.__muxtermDesktop = api;

  // ---------------------------------------------------------------------
  // web -> native: one lifecycle declaration, edge-triggered
  // ---------------------------------------------------------------------

  // Edge-triggered, not level-triggered. The voice controller emits a snapshot
  // on every level-meter tick; forwarding all of those would put a ~30 Hz IPC
  // stream on the bridge for information native does not use. Native only ever
  // needs the transitions.
  let lastActive: boolean | undefined;

  const push = (active: boolean, detail: string): void => {
    if (active === lastActive) return;
    lastActive = active;
    const decl: VoiceStateDeclaration = { active, detail };
    void host.declareVoiceState(decl).catch(() => {
      // Native side unavailable. Cosmetic only: the worst case is that the
      // machine idle-sleeps mid-conversation, which is what a browser tab
      // does anyway. Never escalate this to the user.
    });
  };

  const unsubscribe = voice.subscribe((snapshot) => {
    // 'idle' and 'error' are the two terminal states in
    // VoiceSessionState; everything else means a session exists.
    const active = snapshot.state !== 'idle' && snapshot.state !== 'error';
    push(active, snapshot.state);
  });

  // Declare the state we are already in, so a wrapper that reloaded the page
  // mid-call does not sit holding a stale assertion.
  push(voice.isActive(), 'initial');

  return () => {
    unsubscribe();
    push(false, 'teardown');
    if (window.__muxtermDesktop === api) delete window.__muxtermDesktop;
  };
}
