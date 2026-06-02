import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/status-bar.js';

import type { MuxStatusBar } from '../components/status-bar.js';
import type { SessiondWorkspaceInfo } from '../types.js';

async function fixture(
  props: Partial<{
    workspaces: SessiondWorkspaceInfo[];
    currentWorkspaceId: string;
    connectionStatus: 'connected' | 'disconnected' | 'reconnecting';
    driverActive: boolean;
  }> = {},
): Promise<MuxStatusBar> {
  const el = document.createElement('mux-status-bar') as MuxStatusBar;
  if (props.workspaces !== undefined) el.workspaces = props.workspaces;
  if (props.currentWorkspaceId !== undefined) el.currentWorkspaceId = props.currentWorkspaceId;
  if (props.connectionStatus !== undefined) el.connectionStatus = props.connectionStatus;
  if (props.driverActive !== undefined) el.driverActive = props.driverActive;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxStatusBar', () => {
  let el: MuxStatusBar;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  it('registers as mux-status-bar custom element', () => {
    const ctor = customElements.get('mux-status-bar');
    expect(ctor).toBeDefined();
  });

  it('renders the workspace switcher with the current workspace name', async () => {
    el = await fixture({
      workspaces: [{ workspaceId: 'w1', name: 'work', paneCount: 1 }],
      currentWorkspaceId: 'w1',
    });
    const chip = el.shadowRoot!.querySelector('.workspace-switcher');
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain('work');
  });

  it('falls back to the workspace id when the workspace is unnamed', async () => {
    el = await fixture({
      workspaces: [{ workspaceId: 'w2', paneCount: 1 }],
      currentWorkspaceId: 'w2',
    });
    const chip = el.shadowRoot!.querySelector('.workspace-switcher');
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain('w2');
  });

  it('emits open-workspace-picker (bubbles, composed) when the switcher is clicked', async () => {
    el = await fixture({
      workspaces: [{ workspaceId: 'w1', name: 'work', paneCount: 1 }],
      currentWorkspaceId: 'w1',
    });
    const handler = vi.fn();
    el.addEventListener('open-workspace-picker', handler);
    const chip = el.shadowRoot!.querySelector('.workspace-switcher') as HTMLButtonElement;
    chip.click();
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
  });

  it('shows no window / session / pane count text', async () => {
    el = await fixture({
      workspaces: [
        { workspaceId: 'w1', name: 'work', paneCount: 1 },
        { workspaceId: 'w2', name: 'play', paneCount: 3 },
      ],
      currentWorkspaceId: 'w1',
    });
    const text = el.shadowRoot!.textContent!;
    expect(text).not.toContain('window');
    expect(text).not.toContain('session');
    expect(text).not.toContain('panes');
  });

  it('shows connected status with correct class', async () => {
    el = await fixture({ connectionStatus: 'connected' });
    const status = el.shadowRoot!.querySelector('.right .connected');
    expect(status).toBeTruthy();
    expect(status!.textContent!.toLowerCase()).toContain('connected');
  });

  it('shows disconnected status with correct class', async () => {
    el = await fixture({ connectionStatus: 'disconnected' });
    const status = el.shadowRoot!.querySelector('.right .disconnected');
    expect(status).toBeTruthy();
  });

  it('shows reconnecting status with correct class', async () => {
    el = await fixture({ connectionStatus: 'reconnecting' });
    const status = el.shadowRoot!.querySelector('.right .reconnecting');
    expect(status).toBeTruthy();
  });

  it('defaults connectionStatus to disconnected', async () => {
    el = await fixture();
    const status = el.shadowRoot!.querySelector('.right .disconnected');
    expect(status).toBeTruthy();
  });

  it('has left and right sections', async () => {
    el = await fixture({ connectionStatus: 'connected' });
    const left = el.shadowRoot!.querySelector('.left');
    const right = el.shadowRoot!.querySelector('.right');
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
  });
});

describe('MuxStatusBar goal segment', () => {
  let el: MuxStatusBar;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  it('hides .goal when driverActive is false', async () => {
    el = document.createElement('mux-status-bar') as MuxStatusBar;
    el.driverActive = false;
    document.body.appendChild(el);
    await el.updateComplete;

    const goal = el.shadowRoot!.querySelector('.goal');
    expect(goal).toBeNull();
  });

  it('shows the goal span when driverActive is true', async () => {
    el = document.createElement('mux-status-bar') as MuxStatusBar;
    el.driverActive = true;
    document.body.appendChild(el);
    await el.updateComplete;

    const goal = el.shadowRoot!.querySelector('.goal');
    expect(goal).toBeTruthy();
    expect(goal!.textContent).toContain('goal');
  });
});
