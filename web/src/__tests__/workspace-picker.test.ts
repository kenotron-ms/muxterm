import { describe, it, expect, vi, afterEach } from 'vitest';
import '../components/workspace-picker.js';
import { workspaceLabel, type MuxWorkspacePicker } from '../components/workspace-picker.js';
import type { SessiondWorkspaceInfo } from '../types.js';

function makeWorkspaces(): SessiondWorkspaceInfo[] {
  return [
    { workspaceId: 'ws-1', name: 'main', paneCount: 3 },
    { workspaceId: 'ws-2', paneCount: 1 },
    { workspaceId: 'ws-3', name: 'logs', paneCount: 2 },
  ];
}

async function fixture(
  workspaces: SessiondWorkspaceInfo[] = [],
  currentWorkspaceId = '',
): Promise<MuxWorkspacePicker> {
  const el = document.createElement('mux-workspace-picker') as MuxWorkspacePicker;
  el.workspaces = workspaces;
  if (currentWorkspaceId) el.currentWorkspaceId = currentWorkspaceId;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxWorkspacePicker', () => {
  let el: MuxWorkspacePicker;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
    vi.restoreAllMocks();
  });

  it('registers as mux-workspace-picker custom element', () => {
    const ctor = customElements.get('mux-workspace-picker');
    expect(ctor).toBeDefined();
  });

  it('renders one .ws-item row per workspace', async () => {
    el = await fixture(makeWorkspaces());
    const items = el.shadowRoot!.querySelectorAll('.ws-item');
    expect(items.length).toBe(3);
  });

  it('renders a .ws-check column for every row, reserving space when not current', async () => {
    el = await fixture(makeWorkspaces(), 'ws-2');
    const checks = el.shadowRoot!.querySelectorAll('.ws-check');
    expect(checks.length).toBe(3);
    expect(checks[0].querySelector('svg')).toBeNull();
    expect(checks[1].querySelector('svg')).not.toBeNull();
  });

  it('keeps rename + close actions inside a non-button .ws-item row', async () => {
    el = await fixture(makeWorkspaces());
    const item = el.shadowRoot!.querySelector('.ws-item')!;
    expect(item).toBeTruthy();
    expect(item.tagName).not.toBe('BUTTON');
    expect(item.querySelectorAll('.row-action').length).toBe(2);
  });

  it('labels named workspaces by their name', async () => {
    el = await fixture(makeWorkspaces());
    const names = Array.from(el.shadowRoot!.querySelectorAll('.ws-item')).map(
      (btn) => btn.querySelector('.ws-name')?.textContent,
    );
    expect(names[0]).toBe('main');
    expect(names[2]).toBe('logs');
  });

  it('labels unnamed workspaces by stable id fallback', async () => {
    el = await fixture(makeWorkspaces());
    const names = Array.from(el.shadowRoot!.querySelectorAll('.ws-item')).map(
      (btn) => btn.querySelector('.ws-name')?.textContent,
    );
    expect(names[1]).toBe('workspace 2');
  });

  it('displays pane-count meta with correct pluralization', async () => {
    el = await fixture(makeWorkspaces());
    const metas = Array.from(el.shadowRoot!.querySelectorAll('.ws-item')).map(
      (btn) => btn.querySelector('.ws-meta')?.textContent?.trim(),
    );
    expect(metas).toEqual(['3 panes', '1 pane', '2 panes']);
  });

  it('marks the current workspace with .sel', async () => {
    el = await fixture(makeWorkspaces(), 'ws-2');
    const sel = el.shadowRoot!.querySelectorAll('.ws-item.sel');
    expect(sel.length).toBe(1);
    expect(sel[0].querySelector('.ws-name')?.textContent).toBe('workspace 2');
  });

  it('dispatches workspace-selected with workspaceId on row click', async () => {
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('workspace-selected', handler as EventListener);

    const selectors = el.shadowRoot!.querySelectorAll('button.ws-sel');
    (selectors[1] as HTMLButtonElement).click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ workspaceId: string }>;
    expect(event.detail.workspaceId).toBe('ws-2');
  });

  it('dispatches workspace-create when the new-workspace button is clicked', async () => {
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('workspace-create', handler as EventListener);

    const newBtn = el.shadowRoot!.querySelector('button.ws-new') as HTMLButtonElement;
    expect(newBtn).toBeTruthy();
    newBtn.click();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('dispatches workspace-rename with workspaceId and name via inline edit', async () => {
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('workspace-rename', handler as EventListener);

    // Click the rename button for ws-3 (3rd workspace, index 2)
    const renameBtn = el.shadowRoot!.querySelectorAll('button.ws-rename')[2] as HTMLButtonElement;
    expect(renameBtn).toBeTruthy();
    renameBtn.click();
    await el.updateComplete;

    // Fill in the inline edit input
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('.ws-edit-input');
    expect(input).toBeTruthy();
    input!.value = '  renamed  ';
    input!.dispatchEvent(new Event('input', { bubbles: true }));

    // Click Confirm
    const confirmBtn = el.shadowRoot!.querySelector<HTMLButtonElement>('button[title="Confirm"]');
    expect(confirmBtn).toBeTruthy();
    confirmBtn!.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ workspaceId: string; name: string }>;
    expect(event.detail.workspaceId).toBe('ws-3');
    expect(event.detail.name).toBe('renamed');
  });

  it('dispatches workspace-close with workspaceId on close-row click', async () => {
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('workspace-close', handler as EventListener);

    const closeBtn = el.shadowRoot!.querySelectorAll('button.ws-close')[0] as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    closeBtn.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ workspaceId: string }>;
    expect(event.detail.workspaceId).toBe('ws-1');
  });

  it('dispatches close-picker when the overlay is clicked', async () => {
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('close-picker', handler as EventListener);

    const overlay = el.shadowRoot!.querySelector('.overlay') as HTMLElement;
    overlay.click();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('defaults workspaces to an empty array', async () => {
    const picker = document.createElement('mux-workspace-picker') as MuxWorkspacePicker;
    document.body.appendChild(picker);
    await picker.updateComplete;
    el = picker;
    expect(picker.workspaces).toEqual([]);
    const items = picker.shadowRoot!.querySelectorAll('.ws-item');
    expect(items.length).toBe(0);
  });
});

describe('MuxWorkspacePicker errored-row failure UX', () => {
  let el: MuxWorkspacePicker;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
    vi.restoreAllMocks();
  });

  async function erroredFixture(): Promise<MuxWorkspacePicker> {
    const picker = document.createElement('mux-workspace-picker') as MuxWorkspacePicker;
    picker.workspaces = [
      { workspaceId: 'ws-1', name: 'main', paneCount: 1 },
      { workspaceId: 'ws-2', name: 'logs', paneCount: 1 },
    ];
    picker.erroredMutations = [{ id: 'm7', workspaceId: 'ws-1', kind: 'rename' }];
    document.body.appendChild(picker);
    await picker.updateComplete;
    return picker;
  }

  it('marks the targeted row errored and keeps it visible', async () => {
    el = await erroredFixture();
    const items = el.shadowRoot!.querySelectorAll('.ws-item');
    expect(items.length).toBe(2);
    const errored = el.shadowRoot!.querySelectorAll('.ws-item.errored');
    expect(errored.length).toBe(1);
    expect(errored[0].querySelector('.ws-name')?.textContent).toBe('main');
  });

  it('renders retry and dismiss affordances on errored row', async () => {
    el = await erroredFixture();
    const retry = el.shadowRoot!.querySelector('button.ws-retry');
    const dismiss = el.shadowRoot!.querySelector('button.ws-dismiss');
    expect(retry).toBeTruthy();
    expect(dismiss).toBeTruthy();
  });

  it('dispatches workspace-retry with mutation id', async () => {
    el = await erroredFixture();
    const handler = vi.fn();
    el.addEventListener('workspace-retry', handler as EventListener);

    const retryBtn = el.shadowRoot!.querySelector('button.ws-retry') as HTMLButtonElement;
    retryBtn.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ mutationId: string }>;
    expect(event.detail.mutationId).toBe('m7');
  });

  it('dispatches workspace-dismiss with mutation id', async () => {
    el = await erroredFixture();
    const handler = vi.fn();
    el.addEventListener('workspace-dismiss', handler as EventListener);

    const dismissBtn = el.shadowRoot!.querySelector('button.ws-dismiss') as HTMLButtonElement;
    dismissBtn.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ mutationId: string }>;
    expect(event.detail.mutationId).toBe('m7');
  });

  it('defaults erroredMutations to an empty array', async () => {
    const picker = document.createElement('mux-workspace-picker') as MuxWorkspacePicker;
    document.body.appendChild(picker);
    await picker.updateComplete;
    el = picker;
    expect(picker.erroredMutations).toEqual([]);
  });
});

describe('workspaceLabel helper', () => {
  it('returns the explicit name when present', () => {
    expect(workspaceLabel({ workspaceId: 'ws-9', name: 'alpha', paneCount: 0 })).toBe('alpha');
  });

  it('falls back to a lowercase, id-derived "workspace N" label', () => {
    expect(workspaceLabel({ workspaceId: 'w3', name: undefined, paneCount: 0 })).toBe('workspace 3');
    expect(workspaceLabel({ workspaceId: 'ws-9', name: '', paneCount: 0 })).toBe('workspace 9');
    expect(workspaceLabel({ workspaceId: 'w12', paneCount: 0 })).toBe('workspace 12');
  });

  it('uses the raw id when it contains no digits', () => {
    expect(workspaceLabel({ workspaceId: 'main', paneCount: 0 })).toBe('workspace main');
  });
});
