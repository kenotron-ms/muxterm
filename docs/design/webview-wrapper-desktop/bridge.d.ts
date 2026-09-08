/**
 * muxterm desktop wrapper -- BRIDGE CONTRACT, v1.
 *
 * This file is the whole seam between the native wrapper and the web app.
 * If it grows, the wrapper is becoming a product. See D3 in
 * docs/design/webview-wrapper-desktop.md.
 *
 * TWO GLOBALS, ONE PER DIRECTION. Each side installs its own; neither side
 * installs the other's. That is what makes presence detection honest: the page
 * cannot fake being wrapped, and the host cannot fake a page that is ready.
 *
 *   window.__muxtermHost      installed by NATIVE, before page load, via
 *                             WebviewBuilder::initialization_script.
 *                             The page calls into it.
 *
 *   window.__muxtermDesktop   installed by the WEB APP, once, at startup, only
 *                             when __muxtermHost is present.
 *                             Native calls into it via Webview::eval.
 *
 * WHAT CROSSES: intent (two verbs, native -> web) and lifecycle (one state
 * declaration, web -> native).
 *
 * WHAT MUST NEVER CROSS, in either direction:
 *   - terminal bytes, PTY output, command text, session content of any kind
 *   - credentials, cookies, bearer tokens, the realtime ephemeral key
 *   - audio samples, encoded frames, VAD decisions, transcripts
 *   - realtime tool calls or any realtime protocol frame
 *   - UI state: layout, focus, which pane or workspace is open
 *   - filesystem paths, or anything the native side could turn into a read
 *
 * The rule in one line: THE BRIDGE CARRIES INTENT AND LIFECYCLE, NEVER CONTENT.
 */

/** Bumped only on a breaking change to this file. */
export type BridgeVersion = 1;

/**
 * Verbs native may send the page. Closed set, no payload.
 *
 * No payload is the point. Native says "the user asked to toggle voice"; the
 * page decides whether that means start, stop, or nothing, using state native
 * does not have and must not be given.
 */
export type DesktopCommand = 'voice.toggle' | 'voice.stop';

/**
 * The page's declaration that a voice session did or did not just become live.
 *
 * This is a DECLARATION, not a request. The page is not asking native to do
 * anything; native decides for itself what to do with the fact (hold an OS
 * wake assertion, change the tray icon, keep the process alive).
 */
export interface VoiceStateDeclaration {
  active: boolean;
  /**
   * Free text, for logs and the tray tooltip only. Never parsed, never
   * branched on. Must not contain session content.
   */
  detail?: string;
}

/** Installed by native, read by the page. */
export interface MuxtermHost {
  readonly bridge: BridgeVersion;
  /** 'macos' | 'windows' | 'linux'. Informational; the page must not branch behaviour on it. */
  readonly platform: string;
  /** Wrapper version string, for the page's diagnostics view. */
  readonly appVersion: string;
  /**
   * Tell native a voice session started or stopped.
   * Rejects if the host command is unavailable. The caller must treat a
   * rejection as cosmetic: the conversation is unaffected.
   */
  declareVoiceState(state: VoiceStateDeclaration): Promise<void>;
}

/** Installed by the page, called by native. */
export interface MuxtermDesktop {
  readonly bridge: BridgeVersion;
  /**
   * Handle one verb. Native invokes this by eval'ing a literal string built
   * from the closed DesktopCommand set, so the argument is never attacker-
   * controlled -- but this implementation still rejects unknown verbs rather
   * than trusting that.
   */
  command(verb: DesktopCommand): void;
}

declare global {
  interface Window {
    __muxtermHost?: MuxtermHost;
    __muxtermDesktop?: MuxtermDesktop;
  }
}
