import { describe, it, expect, beforeEach } from 'vitest';

// terminal-registry is a module-level singleton. @xterm/xterm is aliased to
// the setup.ts mock (see vite.config.ts).
import { terminalRegistry } from '../lib/terminal-registry.js';
import type { PaneHandlers } from '../lib/terminal-registry.js';

// Workspace-local panes are keyed by paneId (localPaneId). Exactly one
// workspace is attached at a time and paneIds are reused across workspaces,
// so switching the attached workspace must dispose the previous terminals.
const noopHandlers: PaneHandlers = { onInput: () => {}, onResize: () => {} };

describe('terminalRegistry.disposeAll — workspace switch', () => {
  beforeEach(() => {
    terminalRegistry.disposeAll();
  });

  it('removes every terminal so localPaneIds can be reused', () => {
    terminalRegistry.ensure(1, noopHandlers);
    terminalRegistry.ensure(2, noopHandlers);
    expect(terminalRegistry.getTerminal(1)).toBeTruthy();
    expect(terminalRegistry.getTerminal(2)).toBeTruthy();

    terminalRegistry.disposeAll();

    expect(terminalRegistry.getTerminal(1)).toBeNull();
    expect(terminalRegistry.getTerminal(2)).toBeNull();
  });

  it('re-ensuring a reused paneId after a switch yields a fresh distinct terminal', () => {
    terminalRegistry.ensure(1, noopHandlers);
    const before = terminalRegistry.getTerminal(1);
    expect(before).toBeTruthy();

    // Simulate switching the attached workspace.
    terminalRegistry.disposeAll();
    expect(terminalRegistry.getTerminal(1)).toBeNull();

    // Re-ensure the reused paneId in the newly attached workspace.
    terminalRegistry.ensure(1, noopHandlers);
    const after = terminalRegistry.getTerminal(1);

    expect(after).toBeTruthy();
    expect(after).not.toBe(before); // no cross-workspace bleed
  });
});
