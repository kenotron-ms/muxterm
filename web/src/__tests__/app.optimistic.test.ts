import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessiondType } from '../types.js';
import type { MuxWorkspacePicker } from '../components/workspace-picker.js';

// Mock WebSocket before importing app (mirrors app.sessiond.test.ts).
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.OPEN;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => this.onopen?.());
  }

  send = vi.fn();
  close = vi.fn();
}

// @ts-expect-error mock WebSocket globally
globalThis.WebSocket = MockWebSocket;

import type { MuxApp } from '../app.js';
import '../app.js';
import { store } from '../state.js';
import type { MutationSpec } from '../state.js';

function seedWorkspaces(): void {
  store.applySessiond({
    type: SessiondType.WorkspaceList,
    workspaces: [{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }],
  });
}

async function openPicker(): Promise<MuxApp> {
  const el = document.createElement('mux-app') as MuxApp;
  document.body.appendChild(el);
  await el.updateComplete;
  (el as unknown as { _showWorkspacePicker: boolean })._showWorkspacePicker = true;
  el.requestUpdate();
  await el.updateComplete;
  return el;
}

describe('MuxApp optimistic workspace-rename', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    // Dismiss any lingering (errored/pending) mutations so they don't leak.
    for (const m of store.erroredMutations) store.dismiss(m.id);
    // Reset sessiond store state between tests.
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    el = null as unknown as MuxApp;
  });

  it('routes workspace-rename through store.mutate and shows the new name instantly', async () => {
    seedWorkspaces();
    el = await openPicker();

    const picker = el.shadowRoot!.querySelector('mux-workspace-picker')!;
    const mutateSpy = vi.spyOn(store, 'mutate');

    picker.dispatchEvent(
      new CustomEvent('workspace-rename', {
        bubbles: true,
        composed: true,
        detail: { workspaceId: 'ws-1', name: 'renamed' },
      }),
    );

    expect(mutateSpy).toHaveBeenCalledTimes(1);

    // Instant optimistic overlay: the folded view shows the new name immediately.
    const ws = store.workspaces.find((w) => w.workspaceId === 'ws-1');
    expect(ws?.name).toBe('renamed');

    // Verify the settle predicate routes off the authoritative base.
    const spec = mutateSpy.mock.calls[0][0] as MutationSpec;
    expect(
      spec.settled({
        workspaces: [{ workspaceId: 'ws-1', name: 'renamed', paneCount: 0 }],
        panes: [],
      }),
    ).toBe(true);
    expect(
      spec.settled({
        workspaces: [{ workspaceId: 'ws-1', name: 'old', paneCount: 0 }],
        panes: [],
      }),
    ).toBe(false);

    mutateSpy.mockRestore();
  });
});

describe('MuxApp errored-row wiring', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    // Dismiss any lingering (errored/pending) mutations so they don't leak.
    for (const m of store.erroredMutations) store.dismiss(m.id);
    // Reset sessiond store state between tests.
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    el = null as unknown as MuxApp;
    vi.useRealTimers();
  });

  it('passes store.erroredMutations into the picker and forwards retry/dismiss', async () => {
    vi.useFakeTimers();
    seedWorkspaces();
    el = await openPicker();

    const picker = el.shadowRoot!.querySelector('mux-workspace-picker') as MuxWorkspacePicker;

    // Rename that never settles → times out into an errored mutation.
    picker.dispatchEvent(
      new CustomEvent('workspace-rename', {
        bubbles: true,
        composed: true,
        detail: { workspaceId: 'ws-1', name: 'renamed' },
      }),
    );

    vi.advanceTimersByTime(5000);
    await el.updateComplete;

    // The errored mutation prop is received by the picker.
    expect(picker.erroredMutations.length).toBe(1);
    expect(picker.erroredMutations[0].workspaceId).toBe('ws-1');

    const retrySpy = vi.spyOn(store, 'retry');
    const dismissSpy = vi.spyOn(store, 'dismiss');
    const mutationId = store.erroredMutations[0].id;

    picker.dispatchEvent(
      new CustomEvent('workspace-retry', {
        bubbles: true,
        composed: true,
        detail: { mutationId },
      }),
    );
    expect(retrySpy).toHaveBeenCalledWith(mutationId);

    picker.dispatchEvent(
      new CustomEvent('workspace-dismiss', {
        bubbles: true,
        composed: true,
        detail: { mutationId },
      }),
    );
    expect(dismissSpy).toHaveBeenCalledWith(mutationId);

    retrySpy.mockRestore();
    dismissSpy.mockRestore();
  });
});

describe('MuxApp optimistic close wiring', () => {
  let el: MuxApp;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    // Dismiss any lingering (errored/pending) mutations so they don't leak.
    for (const m of store.erroredMutations) store.dismiss(m.id);
    // Reset sessiond store state between tests.
    store.applySessiond({ type: SessiondType.WorkspaceList, workspaces: [] });
    store.applySessiond({ type: SessiondType.Composition, workspaceId: '', panes: [] });
    el = null as unknown as MuxApp;
  });

  it('routes workspace-close through store.mutate and removes the row instantly', async () => {
    store.applySessiond({
      type: SessiondType.WorkspaceList,
      workspaces: [
        { workspaceId: 'ws-1', name: 'a', paneCount: 0 },
        { workspaceId: 'ws-2', name: 'b', paneCount: 0 },
      ],
    });
    el = await openPicker();

    const picker = el.shadowRoot!.querySelector('mux-workspace-picker')!;
    const mutateSpy = vi.spyOn(store, 'mutate');

    picker.dispatchEvent(
      new CustomEvent('workspace-close', {
        bubbles: true,
        composed: true,
        detail: { workspaceId: 'ws-1' },
      }),
    );

    expect(mutateSpy).toHaveBeenCalledTimes(1);

    // Instant optimistic removal: the folded view drops the row immediately.
    expect(store.workspaces.map((w) => w.workspaceId)).toEqual(['ws-2']);

    // Verify the settle predicate routes off the authoritative base.
    const spec = mutateSpy.mock.calls[0][0] as MutationSpec;
    expect(
      spec.settled({
        workspaces: [{ workspaceId: 'ws-2', name: 'b', paneCount: 0 }],
        panes: [],
      }),
    ).toBe(true);
    expect(
      spec.settled({
        workspaces: [
          { workspaceId: 'ws-1', name: 'a', paneCount: 0 },
          { workspaceId: 'ws-2', name: 'b', paneCount: 0 },
        ],
        panes: [],
      }),
    ).toBe(false);

    mutateSpy.mockRestore();
  });
});
