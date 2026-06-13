/**
 * mux-sidebar.ts unit tests
 * TDD: tests written before implementation to define the exported API.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  MuxSidebar,
} from '../components/mux-sidebar.js';

describe('mux-sidebar constants', () => {
  it('exports SIDEBAR_WIDTH_KEY', () => {
    expect(SIDEBAR_WIDTH_KEY).toBe('mux-sidebar-width');
  });

  it('exports SIDEBAR_DEFAULT_WIDTH = 220', () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(220);
  });

  it('exports SIDEBAR_MIN_WIDTH = 160', () => {
    expect(SIDEBAR_MIN_WIDTH).toBe(160);
  });

  it('exports SIDEBAR_MAX_WIDTH = 360', () => {
    expect(SIDEBAR_MAX_WIDTH).toBe(360);
  });
});

describe('MuxSidebar class', () => {
  it('is a constructor function (a class)', () => {
    expect(typeof MuxSidebar).toBe('function');
  });

  it('has restoreWorkspace as a public method on the prototype', () => {
    expect(typeof MuxSidebar.prototype.restoreWorkspace).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Workspace switching interactions
// ---------------------------------------------------------------------------

type SidebarPrivate = {
  _onWsClick(wsId: string): void;
  _startRename(e: Event, wsId: string): void;
  _onRenameKeyDown(e: KeyboardEvent, wsId: string): void;
  _finishRename(e: Event, wsId: string): void;
  _renaming: string | null;
  _onWsRemove(e: Event, wsId: string, name: string): void;
  _pendingClose: Set<string>;
};

/** Cast sidebar to its private API for white-box testing. */
function priv(s: MuxSidebar): SidebarPrivate {
  return s as unknown as SidebarPrivate;
}

describe('MuxSidebar workspace-switch interaction', () => {
  it('dispatches workspace-switch event when a workspace card is clicked', () => {
    const sidebar = new MuxSidebar();
    const captured: CustomEvent[] = [];
    sidebar.addEventListener('workspace-switch', (e) => captured.push(e as CustomEvent));

    priv(sidebar)._onWsClick('ws-1');

    expect(captured).toHaveLength(1);
    expect(captured[0].detail).toEqual({ workspaceId: 'ws-1' });
  });

  it('workspace-switch event has bubbles=true and composed=true', () => {
    const sidebar = new MuxSidebar();
    let evt: CustomEvent | null = null;
    sidebar.addEventListener('workspace-switch', (e) => {
      evt = e as CustomEvent;
    });

    priv(sidebar)._onWsClick('ws-xyz');

    expect(evt).not.toBeNull();
    expect(evt!.bubbles).toBe(true);
    expect(evt!.composed).toBe(true);
  });

  it('dispatches workspace-switch with the correct workspaceId for each click target', () => {
    const sidebar = new MuxSidebar();
    const wsIds: string[] = [];
    sidebar.addEventListener('workspace-switch', (e) =>
      wsIds.push((e as CustomEvent).detail.workspaceId),
    );

    priv(sidebar)._onWsClick('ws-A');
    priv(sidebar)._onWsClick('ws-B');

    expect(wsIds).toEqual(['ws-A', 'ws-B']);
  });
});

// ---------------------------------------------------------------------------
// Double-click rename interactions
// ---------------------------------------------------------------------------

describe('MuxSidebar double-click rename', () => {
  it('_startRename sets _renaming to the workspace ID', () => {
    const sidebar = new MuxSidebar();
    const mockEvent = { stopPropagation: vi.fn() } as unknown as Event;

    priv(sidebar)._startRename(mockEvent, 'ws-1');

    expect(priv(sidebar)._renaming).toBe('ws-1');
  });

  it('_startRename calls stopPropagation to prevent card click from firing', () => {
    const sidebar = new MuxSidebar();
    const stopPropagation = vi.fn();
    priv(sidebar)._startRename({ stopPropagation } as unknown as Event, 'ws-1');

    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('_onRenameKeyDown Enter dispatches workspace-rename with the new name', () => {
    const sidebar = new MuxSidebar();
    const captured: CustomEvent[] = [];
    sidebar.addEventListener('workspace-rename', (e) => captured.push(e as CustomEvent));

    const input = document.createElement('input');
    input.value = 'my-dev';
    const mockEvent = {
      key: 'Enter',
      preventDefault: vi.fn(),
      target: input,
    } as unknown as KeyboardEvent;

    priv(sidebar)._onRenameKeyDown(mockEvent, 'ws-1');

    expect(captured).toHaveLength(1);
    expect(captured[0].detail).toEqual({ workspaceId: 'ws-1', name: 'my-dev' });
  });

  it('_onRenameKeyDown Enter clears _renaming after confirming', () => {
    const sidebar = new MuxSidebar();

    // Start rename
    priv(sidebar)._startRename({ stopPropagation: vi.fn() } as unknown as Event, 'ws-1');
    expect(priv(sidebar)._renaming).toBe('ws-1');

    // Confirm with Enter
    const input = document.createElement('input');
    input.value = 'my-dev';
    priv(sidebar)._onRenameKeyDown(
      { key: 'Enter', preventDefault: vi.fn(), target: input } as unknown as KeyboardEvent,
      'ws-1',
    );

    expect(priv(sidebar)._renaming).toBeNull();
  });

  it('_onRenameKeyDown Enter trims whitespace from the name', () => {
    const sidebar = new MuxSidebar();
    const captured: CustomEvent[] = [];
    sidebar.addEventListener('workspace-rename', (e) => captured.push(e as CustomEvent));

    const input = document.createElement('input');
    input.value = '  staging  ';
    priv(sidebar)._onRenameKeyDown(
      { key: 'Enter', preventDefault: vi.fn(), target: input } as unknown as KeyboardEvent,
      'ws-2',
    );

    expect(captured[0].detail.name).toBe('staging');
  });

  it('_onRenameKeyDown Enter does not dispatch event when name is empty or whitespace-only', () => {
    const sidebar = new MuxSidebar();
    const captured: CustomEvent[] = [];
    sidebar.addEventListener('workspace-rename', (e) => captured.push(e as CustomEvent));

    const input = document.createElement('input');
    input.value = '   ';
    priv(sidebar)._onRenameKeyDown(
      { key: 'Enter', preventDefault: vi.fn(), target: input } as unknown as KeyboardEvent,
      'ws-1',
    );

    expect(captured).toHaveLength(0);
    expect(priv(sidebar)._renaming).toBeNull();
  });

  it('_onRenameKeyDown Escape cancels rename without dispatching workspace-rename', () => {
    const sidebar = new MuxSidebar();
    const captured: CustomEvent[] = [];
    sidebar.addEventListener('workspace-rename', (e) => captured.push(e as CustomEvent));

    // Start a rename first
    priv(sidebar)._startRename({ stopPropagation: vi.fn() } as unknown as Event, 'ws-1');
    expect(priv(sidebar)._renaming).toBe('ws-1');

    // Press Escape to cancel
    priv(sidebar)._onRenameKeyDown(
      {
        key: 'Escape',
        preventDefault: vi.fn(),
        target: document.createElement('input'),
      } as unknown as KeyboardEvent,
      'ws-1',
    );

    expect(captured).toHaveLength(0);
    expect(priv(sidebar)._renaming).toBeNull();
  });

  it('_finishRename dispatches workspace-rename on blur with trimmed name', () => {
    const sidebar = new MuxSidebar();
    const captured: CustomEvent[] = [];
    sidebar.addEventListener('workspace-rename', (e) => captured.push(e as CustomEvent));

    const input = document.createElement('input');
    input.value = '  my-dev  ';
    priv(sidebar)._finishRename({ target: input } as unknown as Event, 'ws-1');

    expect(captured).toHaveLength(1);
    expect(captured[0].detail).toEqual({ workspaceId: 'ws-1', name: 'my-dev' });
    expect(priv(sidebar)._renaming).toBeNull();
  });

  it('_finishRename does not dispatch workspace-rename when name is empty', () => {
    const sidebar = new MuxSidebar();
    const captured: CustomEvent[] = [];
    sidebar.addEventListener('workspace-rename', (e) => captured.push(e as CustomEvent));

    const input = document.createElement('input');
    input.value = '';
    priv(sidebar)._finishRename({ target: input } as unknown as Event, 'ws-1');

    expect(captured).toHaveLength(0);
  });

  it('workspace-rename event has bubbles=true and composed=true', () => {
    const sidebar = new MuxSidebar();
    let evt: CustomEvent | null = null;
    sidebar.addEventListener('workspace-rename', (e) => {
      evt = e as CustomEvent;
    });

    const input = document.createElement('input');
    input.value = 'production';
    priv(sidebar)._onRenameKeyDown(
      { key: 'Enter', preventDefault: vi.fn(), target: input } as unknown as KeyboardEvent,
      'ws-prod',
    );

    expect(evt!.bubbles).toBe(true);
    expect(evt!.composed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Workspace remove × button — grace period and undo
// ---------------------------------------------------------------------------

describe('MuxSidebar workspace-remove (× button) grace period', () => {
  it('_onWsRemove adds the workspace ID to _pendingClose', () => {
    const sidebar = new MuxSidebar();
    const mockEvent = { stopPropagation: vi.fn() } as unknown as Event;

    priv(sidebar)._onWsRemove(mockEvent, 'ws-temp', 'temp');

    expect(priv(sidebar)._pendingClose.has('ws-temp')).toBe(true);
  });

  it('_onWsRemove dispatches workspace-close event with workspaceId and name', () => {
    const sidebar = new MuxSidebar();
    const captured: CustomEvent[] = [];
    sidebar.addEventListener('workspace-close', (e) => captured.push(e as CustomEvent));

    priv(sidebar)._onWsRemove({ stopPropagation: vi.fn() } as unknown as Event, 'ws-temp', 'temp');

    expect(captured).toHaveLength(1);
    expect(captured[0].detail).toEqual({ workspaceId: 'ws-temp', name: 'temp' });
  });

  it('_onWsRemove workspace-close event has bubbles=true and composed=true', () => {
    const sidebar = new MuxSidebar();
    let evt: CustomEvent | null = null;
    sidebar.addEventListener('workspace-close', (e) => { evt = e as CustomEvent; });

    priv(sidebar)._onWsRemove({ stopPropagation: vi.fn() } as unknown as Event, 'ws-1', 'My WS');

    expect(evt).not.toBeNull();
    expect(evt!.bubbles).toBe(true);
    expect(evt!.composed).toBe(true);
  });

  it('_onWsRemove calls stopPropagation to prevent card click from firing', () => {
    const sidebar = new MuxSidebar();
    const stopPropagation = vi.fn();
    priv(sidebar)._onWsRemove({ stopPropagation } as unknown as Event, 'ws-1', 'WS 1');

    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('_onWsRemove adding the same wsId twice still shows it once in _pendingClose', () => {
    const sidebar = new MuxSidebar();
    const mockEvent = { stopPropagation: vi.fn() } as unknown as Event;

    priv(sidebar)._onWsRemove(mockEvent, 'ws-dup', 'dup');
    priv(sidebar)._onWsRemove({ stopPropagation: vi.fn() } as unknown as Event, 'ws-dup', 'dup');

    // Set deduplicates; workspace-close dispatched twice, _pendingClose still has the ID once
    expect(priv(sidebar)._pendingClose.has('ws-dup')).toBe(true);
    expect(priv(sidebar)._pendingClose.size).toBe(1);
  });

  it('_onWsRemove is tracked for multiple distinct workspaces', () => {
    const sidebar = new MuxSidebar();

    priv(sidebar)._onWsRemove({ stopPropagation: vi.fn() } as unknown as Event, 'ws-A', 'A');
    priv(sidebar)._onWsRemove({ stopPropagation: vi.fn() } as unknown as Event, 'ws-B', 'B');

    expect(priv(sidebar)._pendingClose.has('ws-A')).toBe(true);
    expect(priv(sidebar)._pendingClose.has('ws-B')).toBe(true);
    expect(priv(sidebar)._pendingClose.size).toBe(2);
  });
});

describe('MuxSidebar.restoreWorkspace — undo removes pending-close state', () => {
  it('restoreWorkspace removes the wsId from _pendingClose', () => {
    const sidebar = new MuxSidebar();
    priv(sidebar)._onWsRemove({ stopPropagation: vi.fn() } as unknown as Event, 'ws-temp', 'temp');
    expect(priv(sidebar)._pendingClose.has('ws-temp')).toBe(true);

    sidebar.restoreWorkspace('ws-temp');

    expect(priv(sidebar)._pendingClose.has('ws-temp')).toBe(false);
  });

  it('restoreWorkspace on an unknown wsId is a no-op (does not throw)', () => {
    const sidebar = new MuxSidebar();

    expect(() => sidebar.restoreWorkspace('ws-nonexistent')).not.toThrow();
    expect(priv(sidebar)._pendingClose.size).toBe(0);
  });

  it('restoreWorkspace replaces the set reference (Lit reactive property)', () => {
    const sidebar = new MuxSidebar();
    priv(sidebar)._onWsRemove({ stopPropagation: vi.fn() } as unknown as Event, 'ws-x', 'X');
    const before = priv(sidebar)._pendingClose;

    sidebar.restoreWorkspace('ws-x');

    // A new Set instance must be assigned (Lit dirty-checks by reference for Set/Map)
    expect(priv(sidebar)._pendingClose).not.toBe(before);
  });

  it('restoreWorkspace only removes the specified workspace, leaving others intact', () => {
    const sidebar = new MuxSidebar();
    priv(sidebar)._onWsRemove({ stopPropagation: vi.fn() } as unknown as Event, 'ws-1', 'One');
    priv(sidebar)._onWsRemove({ stopPropagation: vi.fn() } as unknown as Event, 'ws-2', 'Two');

    sidebar.restoreWorkspace('ws-1');

    expect(priv(sidebar)._pendingClose.has('ws-1')).toBe(false);
    expect(priv(sidebar)._pendingClose.has('ws-2')).toBe(true);
  });
});
