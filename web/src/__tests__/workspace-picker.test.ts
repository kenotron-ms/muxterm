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

  it('renders one button.ws-item row per workspace', async () => {
    el = await fixture(makeWorkspaces());
    const items = el.shadowRoot!.querySelectorAll('button.ws-item');
    expect(items.length).toBe(3);
  });

  it('labels named workspaces by their name', async () => {
    el = await fixture(makeWorkspaces());
    const names = Array.from(el.shadowRoot!.querySelectorAll('button.ws-item')).map(
      (btn) => btn.querySelector('.ws-name')?.textContent,
    );
    expect(names[0]).toBe('main');
    expect(names[2]).toBe('logs');
  });

  it('labels unnamed workspaces by stable id fallback', async () => {
    el = await fixture(makeWorkspaces());
    const names = Array.from(el.shadowRoot!.querySelectorAll('button.ws-item')).map(
      (btn) => btn.querySelector('.ws-name')?.textContent,
    );
    expect(names[1]).toBe('Workspace ws-2');
  });

  it('displays pane-count meta with correct pluralization', async () => {
    el = await fixture(makeWorkspaces());
    const metas = Array.from(el.shadowRoot!.querySelectorAll('button.ws-item')).map(
      (btn) => btn.querySelector('.ws-meta')?.textContent?.trim(),
    );
    expect(metas).toEqual(['3 panes', '1 pane', '2 panes']);
  });

  it('marks the current workspace with .sel', async () => {
    el = await fixture(makeWorkspaces(), 'ws-2');
    const sel = el.shadowRoot!.querySelectorAll('button.ws-item.sel');
    expect(sel.length).toBe(1);
    expect(sel[0].querySelector('.ws-name')?.textContent).toBe('Workspace ws-2');
  });

  it('dispatches workspace-selected with workspaceId on row click', async () => {
    el = await fixture(makeWorkspaces());
    const handler = vi.fn();
    el.addEventListener('workspace-selected', handler as EventListener);

    const items = el.shadowRoot!.querySelectorAll('button.ws-item');
    (items[1] as HTMLButtonElement).click();

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

  it('dispatches workspace-rename with workspaceId and name from prompt', async () => {
    el = await fixture(makeWorkspaces());
    vi.spyOn(window, 'prompt').mockReturnValue('  renamed  ');
    const handler = vi.fn();
    el.addEventListener('workspace-rename', handler as EventListener);

    const renameBtn = el.shadowRoot!.querySelectorAll('button.ws-rename')[2] as HTMLButtonElement;
    expect(renameBtn).toBeTruthy();
    renameBtn.click();

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
    const items = picker.shadowRoot!.querySelectorAll('button.ws-item');
    expect(items.length).toBe(0);
  });
});

describe('workspaceLabel helper', () => {
  it('returns the name when present, else a stable id fallback', () => {
    expect(workspaceLabel({ workspaceId: 'ws-9', name: 'alpha', paneCount: 0 })).toBe('alpha');
    expect(workspaceLabel({ workspaceId: 'ws-9', name: '', paneCount: 0 })).toBe('Workspace ws-9');
    expect(workspaceLabel({ workspaceId: 'ws-9', paneCount: 0 })).toBe('Workspace ws-9');
  });
});
