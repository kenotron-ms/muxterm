import { describe, it, expect, beforeEach } from 'vitest';

// terminal-registry is a module-level singleton. @xterm/xterm is aliased to
// the setup.ts mock (see vite.config.ts).
import { terminalRegistry } from '../lib/terminal-registry.js';
import type { PaneHandlers } from '../lib/terminal-registry.js';

// Workspace-local panes are keyed by paneId (localPaneId). Pane IDs are
// reused across workspaces, so the registry uses composite keys
// "${workspaceId}:${paneId}" to isolate them without destroying terminals.
const noopHandlers: PaneHandlers = { onInput: () => {}, onResize: () => {} };

describe('terminalRegistry.disposeAll — full teardown', () => {
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

    // Simulate full teardown (disconnect / test cleanup).
    terminalRegistry.disposeAll();
    expect(terminalRegistry.getTerminal(1)).toBeNull();

    // Re-ensure the reused paneId in the newly attached workspace.
    terminalRegistry.ensure(1, noopHandlers);
    const after = terminalRegistry.getTerminal(1);

    expect(after).toBeTruthy();
    expect(after).not.toBe(before); // no cross-workspace bleed
  });
});

describe('terminalRegistry.setWorkspace — scrollback-preserving workspace switch', () => {
  beforeEach(() => {
    terminalRegistry.disposeAll();
  });

  it('getTerminal returns null for a pane in a different workspace', () => {
    // Ensure a pane in workspace A.
    terminalRegistry.setWorkspace('ws-a');
    terminalRegistry.ensure(1, noopHandlers);
    expect(terminalRegistry.getTerminal(1)).toBeTruthy();

    // Switch to workspace B — pane 1 is now invisible.
    terminalRegistry.setWorkspace('ws-b');
    expect(terminalRegistry.getTerminal(1)).toBeNull(); // ws-b has no pane 1 yet
  });

  it('re-ensuring the same paneId in a new workspace creates a distinct terminal', () => {
    terminalRegistry.setWorkspace('ws-a');
    terminalRegistry.ensure(1, noopHandlers);
    const termA = terminalRegistry.getTerminal(1);

    terminalRegistry.setWorkspace('ws-b');
    terminalRegistry.ensure(1, noopHandlers);
    const termB = terminalRegistry.getTerminal(1);

    expect(termA).not.toBe(termB); // isolated — no cross-workspace bleed
  });

  it('switching back to workspace A restores the original terminal', () => {
    terminalRegistry.setWorkspace('ws-a');
    terminalRegistry.ensure(1, noopHandlers);
    const termA = terminalRegistry.getTerminal(1);

    // Switch to B and create a conflicting pane 1.
    terminalRegistry.setWorkspace('ws-b');
    terminalRegistry.ensure(1, noopHandlers);

    // Switch back to A — scrollback terminal is still alive.
    terminalRegistry.setWorkspace('ws-a');
    expect(terminalRegistry.getTerminal(1)).toBe(termA); // same instance — scrollback preserved!
  });

  it('prune only removes panes from the current workspace', () => {
    // Create pane 1 in both workspaces.
    terminalRegistry.setWorkspace('ws-a');
    terminalRegistry.ensure(1, noopHandlers);

    terminalRegistry.setWorkspace('ws-b');
    terminalRegistry.ensure(1, noopHandlers);

    // Pruning in ws-b with empty set removes ws-b's pane 1.
    terminalRegistry.prune(new Set());
    expect(terminalRegistry.getTerminal(1)).toBeNull(); // ws-b:1 pruned

    // ws-a's pane 1 survives.
    terminalRegistry.setWorkspace('ws-a');
    expect(terminalRegistry.getTerminal(1)).toBeTruthy(); // ws-a:1 still alive
  });
});
