// Pane-focus coordinator — client-side half of the multi-client resize/
// focus-authority design
// (docs/designs/2026-07-31-multi-client-resize-focus-authority-design.md).
//
// Claims PTY-sizing authority for panes by sending pane-focus whenever this
// client's view of a pane becomes the one that should drive its size:
//   - the pane becomes the active tab in this client's dockview layout (see
//     app.ts's _onActivePane, which already receives mux-dock's existing
//     bubbling 'pane-select' CustomEvent — dockview's onDidActivePanelChange
//     dispatches it today, unmodified by this change)
//   - this browser tab/window regains OS focus or visibility
//     (visibilitychange + window 'focus' — installWindowListeners below)
//   - a pane settles (first becomes ready) on initial attach or reconnect
//     (terminal-registry's PaneHandlers.onSettled hook, wired per-pane in
//     app.ts)
//
// Deliberately NOT part of WorkspaceController: that class is a thin,
// test-mockable seam with no DOM/wire state of its own beyond client-local
// bookkeeping (see its file header) and is driven externally by callers
// rather than owning window/document listeners itself. This coordinator owns
// real DOM event subscriptions, so it lives as its own small module instead.

import { terminalRegistry } from './terminal-registry.js';

/** Test-mockable subset of MuxSocket the coordinator drives. */
export interface PaneFocusSocket {
  paneFocus(paneId: number, cols: number, rows: number): void;
}

export class PaneFocusCoordinator {
  private socket: PaneFocusSocket;

  constructor(socket: PaneFocusSocket) {
    this.socket = socket;
  }

  /** Claim a single pane — e.g. the one dockview just made active. No-ops if
   *  the pane isn't currently visible (measureForFocus returns null). */
  claimPane(paneId: number): void {
    const size = terminalRegistry.measureForFocus(paneId);
    if (!size) return;
    this.socket.paneFocus(paneId, size.cols, size.rows);
    terminalRegistry.markAuthoritative(paneId);
  }

  /** Claim every pane currently visible in this client's layout — used for
   *  visibilitychange/window-focus, which don't identify a single pane the
   *  way an active-tab change does. */
  claimVisiblePanes(): void {
    for (const paneId of terminalRegistry.visiblePaneIds()) {
      this.claimPane(paneId);
    }
  }

  /**
   * Install visibilitychange + window 'focus' listeners. Both signal "this
   * browser tab/window regained OS focus", per the design's combined
   * visibility+OS-focus authority signal. Returns a disposer for symmetric
   * cleanup, mirroring app.ts's installKeybindings()'s pattern.
   */
  installWindowListeners(): () => void {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        this.claimVisiblePanes();
      }
    };
    const onWindowFocus = (): void => {
      this.claimVisiblePanes();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onWindowFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onWindowFocus);
    };
  }
}
