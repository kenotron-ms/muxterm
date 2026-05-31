import { describe, it, expect, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/status-bar.js';

import type { MuxStatusBar } from '../components/status-bar.js';

async function fixture(
  props: Partial<{
    sessionName: string;
    windowCount: number;
    paneCount: number;
    activeWindowName: string;
    connectionStatus: 'connected' | 'disconnected' | 'reconnecting';
  }> = {},
): Promise<MuxStatusBar> {
  const el = document.createElement('mux-status-bar') as MuxStatusBar;
  if (props.sessionName !== undefined) el.sessionName = props.sessionName;
  if (props.windowCount !== undefined) el.windowCount = props.windowCount;
  if (props.paneCount !== undefined) el.paneCount = props.paneCount;
  if (props.activeWindowName !== undefined) el.activeWindowName = props.activeWindowName;
  if (props.connectionStatus !== undefined) el.connectionStatus = props.connectionStatus;
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

  it('displays session name in brackets', async () => {
    el = await fixture({ sessionName: 'dev' });
    const session = el.shadowRoot!.querySelector('.session');
    expect(session).toBeTruthy();
    expect(session!.textContent).toContain('[dev]');
  });

  it('displays "no session" when sessionName is empty', async () => {
    el = await fixture({ sessionName: '' });
    const session = el.shadowRoot!.querySelector('.session');
    expect(session).toBeTruthy();
    expect(session!.textContent).toContain('no session');
  });

  it('displays window count with plural', async () => {
    el = await fixture({ windowCount: 3 });
    const left = el.shadowRoot!.querySelector('.left');
    expect(left!.textContent).toContain('3 windows');
  });

  it('displays singular "window" for count of 1', async () => {
    el = await fixture({ windowCount: 1 });
    const left = el.shadowRoot!.querySelector('.left');
    expect(left!.textContent).toContain('1 window');
    expect(left!.textContent).not.toContain('1 windows');
  });

  it('displays pane count with plural', async () => {
    el = await fixture({ paneCount: 4, activeWindowName: 'bash' });
    const left = el.shadowRoot!.querySelector('.left');
    expect(left!.textContent).toContain('4 panes');
  });

  it('displays singular "pane" for count of 1', async () => {
    el = await fixture({ paneCount: 1, activeWindowName: 'bash' });
    const left = el.shadowRoot!.querySelector('.left');
    expect(left!.textContent).toContain('1 pane');
    expect(left!.textContent).not.toContain('1 panes');
  });

  it('displays active window name with pane count', async () => {
    el = await fixture({ activeWindowName: 'vim', paneCount: 2 });
    const left = el.shadowRoot!.querySelector('.left');
    const text = left!.textContent!;
    expect(text).toContain('vim');
    expect(text).toContain('2 panes');
  });

  it('has separators between sections', async () => {
    el = await fixture({ sessionName: 'dev', windowCount: 2 });
    const separators = el.shadowRoot!.querySelectorAll('.separator');
    expect(separators.length).toBeGreaterThanOrEqual(1);
  });

  it('shows "connected" status with correct class', async () => {
    el = await fixture({ connectionStatus: 'connected' });
    const right = el.shadowRoot!.querySelector('.right');
    const status = right!.querySelector('.connected');
    expect(status).toBeTruthy();
    expect(status!.textContent!.toLowerCase()).toContain('connected');
  });

  it('shows "disconnected" status with correct class', async () => {
    el = await fixture({ connectionStatus: 'disconnected' });
    const right = el.shadowRoot!.querySelector('.right');
    const status = right!.querySelector('.disconnected');
    expect(status).toBeTruthy();
    expect(status!.textContent!.toLowerCase()).toContain('disconnected');
  });

  it('shows "reconnecting" status with correct class', async () => {
    el = await fixture({ connectionStatus: 'reconnecting' });
    const right = el.shadowRoot!.querySelector('.right');
    const status = right!.querySelector('.reconnecting');
    expect(status).toBeTruthy();
    expect(status!.textContent!.toLowerCase()).toContain('reconnecting');
  });

  it('defaults connectionStatus to disconnected', async () => {
    el = await fixture();
    const right = el.shadowRoot!.querySelector('.right');
    const status = right!.querySelector('.disconnected');
    expect(status).toBeTruthy();
  });

  it('has left and right sections', async () => {
    el = await fixture({ sessionName: 'test', connectionStatus: 'connected' });
    const left = el.shadowRoot!.querySelector('.left');
    const right = el.shadowRoot!.querySelector('.right');
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
  });

  it('clicking .session dispatches open-session-picker event', async () => {
    el = document.createElement('mux-status-bar') as MuxStatusBar;
    el.sessionName = 'dev';
    document.body.appendChild(el);
    await el.updateComplete;

    let counter = 0;
    el.addEventListener('open-session-picker', () => { counter++; });

    const session = el.shadowRoot!.querySelector('.session') as HTMLElement;
    expect(session).toBeTruthy();
    session.click();

    expect(counter).toBe(1);
  });

  it('renders all parts together correctly', async () => {
    el = await fixture({
      sessionName: 'main',
      windowCount: 3,
      paneCount: 2,
      activeWindowName: 'bash',
      connectionStatus: 'connected',
    });

    const left = el.shadowRoot!.querySelector('.left');
    const right = el.shadowRoot!.querySelector('.right');
    const text = left!.textContent!;

    expect(text).toContain('[main]');
    expect(text).toContain('3 windows');
    expect(text).toContain('bash');
    expect(text).toContain('2 panes');

    const connStatus = right!.querySelector('.connected');
    expect(connStatus).toBeTruthy();
  });
});