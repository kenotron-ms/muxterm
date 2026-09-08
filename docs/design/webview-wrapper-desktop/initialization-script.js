// muxterm desktop wrapper -- NATIVE-SIDE HALF OF THE BRIDGE.
//
// Injected by Rust before any page script runs, via
// WebviewBuilder::initialization_script. Main frame only -- NOT
// initialization_script_for_all_frames: on Linux and Android Tauri cannot
// distinguish an <iframe> from the window itself (Tauri capabilities docs,
// "Remote API Access"), so the host object must not be reachable from a frame.
//
// The __VERSION__ / __PLATFORM__ tokens are substituted in Rust with
// serde_json::to_string of a &str, so they arrive as JSON string literals and
// cannot break out of the expression.
//
// This is the ONLY thing native puts on the page. It is one object with one
// method. If a second method appears here, D3's boundary has moved.

(function () {
  'use strict';

  if (window.__muxtermHost) return;

  Object.defineProperty(window, '__muxtermHost', {
    value: Object.freeze({
      bridge: 1,
      platform: __PLATFORM__,
      appVersion: __VERSION__,

      declareVoiceState: function (state) {
        // Tauri's IPC primitive. Reached without withGlobalTauri, so the page
        // never sees window.__TAURI__ and the remote origin holds exactly one
        // permission: allow-declare-voice-state.
        try {
          return window.__TAURI_INTERNALS__.invoke('declare_voice_state', {
            active: !!(state && state.active),
            detail: state && typeof state.detail === 'string' ? state.detail : null,
          });
        } catch (e) {
          return Promise.reject(e);
        }
      },
    }),
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
