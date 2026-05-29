import { describe, it, expect, vi, afterEach } from 'vitest';
import '../components/session-picker.js';
import type { MuxSessionPicker } from '../components/session-picker.js';
import type { SessionInfo } from '../components/session-picker.js';

function makeSessions(): SessionInfo[] {
  return [
    { name: 'dev', windows: 3 },
    { name: 'staging', windows: 1 },
    { name: 'test', windows: 2 },
  ];
}

async function fixture(sessions: SessionInfo[] = []): Promise<MuxSessionPicker> {
  const el = document.createElement('mux-session-picker') as MuxSessionPicker;
  el.sessions = sessions;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxSessionPicker', () => {
  let el: MuxSessionPicker;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  it('registers as mux-session-picker custom element', () => {
    const ctor = customElements.get('mux-session-picker');
    expect(ctor).toBeDefined();
  });

  it('renders a modal overlay with fixed positioning and dark background', async () => {
    el = await fixture(makeSessions());
    const overlay = el.shadowRoot!.querySelector('.overlay');
    expect(overlay).toBeTruthy();
  });

  it('renders inner .picker div', async () => {
    el = await fixture(makeSessions());
    const picker = el.shadowRoot!.querySelector('.picker');
    expect(picker).toBeTruthy();
  });

  it('renders h2 with correct title', async () => {
    el = await fixture(makeSessions());
    const heading = el.shadowRoot!.querySelector('h2');
    expect(heading).toBeTruthy();
    expect(heading!.textContent).toBe('Select a tmux session');
  });

  it('renders a session-list container', async () => {
    el = await fixture(makeSessions());
    const list = el.shadowRoot!.querySelector('.session-list');
    expect(list).toBeTruthy();
  });

  it('renders a button.session-item for each session', async () => {
    el = await fixture(makeSessions());
    const items = el.shadowRoot!.querySelectorAll('button.session-item');
    expect(items.length).toBe(3);
  });

  it('displays session name in each button', async () => {
    el = await fixture(makeSessions());
    const items = el.shadowRoot!.querySelectorAll('button.session-item');
    const names = Array.from(items).map((btn) => btn.querySelector('.session-name')?.textContent);
    expect(names).toEqual(['dev', 'staging', 'test']);
  });

  it('displays window count meta text with correct pluralization', async () => {
    el = await fixture(makeSessions());
    const items = el.shadowRoot!.querySelectorAll('button.session-item');
    const metas = Array.from(items).map((btn) => btn.querySelector('.session-meta')?.textContent);
    expect(metas).toEqual(['3 windows', '1 window', '2 windows']);
  });

  it('dispatches session-selected event with name on click', async () => {
    el = await fixture(makeSessions());
    const handler = vi.fn();
    el.addEventListener('session-selected', handler as EventListener);

    const items = el.shadowRoot!.querySelectorAll('button.session-item');
    (items[1] as HTMLButtonElement).click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ name: string }>;
    expect(event.detail.name).toBe('staging');
  });

  it('session-selected event bubbles and is composed', async () => {
    el = await fixture(makeSessions());
    const handler = vi.fn();
    // Listen on document body (event must bubble out of shadow DOM)
    document.body.addEventListener('session-selected', handler as EventListener);

    const items = el.shadowRoot!.querySelectorAll('button.session-item');
    (items[0] as HTMLButtonElement).click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<{ name: string }>;
    expect(event.detail.name).toBe('dev');

    document.body.removeEventListener('session-selected', handler as EventListener);
  });

  it('renders empty state when sessions is empty', async () => {
    el = await fixture([]);
    const items = el.shadowRoot!.querySelectorAll('button.session-item');
    expect(items.length).toBe(0);
  });

  it('defaults sessions to empty array', async () => {
    const picker = document.createElement('mux-session-picker') as MuxSessionPicker;
    document.body.appendChild(picker);
    await picker.updateComplete;
    el = picker;
    expect(picker.sessions).toEqual([]);
    const items = picker.shadowRoot!.querySelectorAll('button.session-item');
    expect(items.length).toBe(0);
  });

  it('updates when sessions property changes', async () => {
    el = await fixture(makeSessions());
    let items = el.shadowRoot!.querySelectorAll('button.session-item');
    expect(items.length).toBe(3);

    el.sessions = [{ name: 'only-one', windows: 5 }];
    await el.updateComplete;

    items = el.shadowRoot!.querySelectorAll('button.session-item');
    expect(items.length).toBe(1);
    expect(items[0].querySelector('.session-name')?.textContent).toBe('only-one');
  });
});