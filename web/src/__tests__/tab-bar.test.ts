import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the component — triggers custom element registration
import '../components/tab-bar.js';

import type { MuxTabBar } from '../components/tab-bar.js';
import type { Window } from '../types.js';

function makeWindow(id: number, name: string): Window {
  return { id, name, panes: [], layout: '' };
}

async function fixture(
  windows: Window[] = [],
  activeWindowId = '',
): Promise<MuxTabBar> {
  const el = document.createElement('mux-tab-bar') as MuxTabBar;
  el.windows = windows;
  el.activeWindowId = activeWindowId;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('MuxTabBar', () => {
  let el: MuxTabBar;

  afterEach(() => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  it('renders tabs from windows array', async () => {
    const windows = [
      makeWindow(1, 'bash'),
      makeWindow(2, 'vim'),
      makeWindow(3, 'htop'),
    ];
    el = await fixture(windows);

    const tabs = el.shadowRoot!.querySelectorAll('.tab');
    expect(tabs.length).toBe(3);

    // Check text content includes window names
    const texts = Array.from(tabs).map((t) => t.textContent?.trim());
    expect(texts[0]).toContain('bash');
    expect(texts[1]).toContain('vim');
    expect(texts[2]).toContain('htop');
  });

  it('marks the active tab', async () => {
    const windows = [
      makeWindow(1, 'bash'),
      makeWindow(2, 'vim'),
    ];
    el = await fixture(windows, '2');

    const tabs = el.shadowRoot!.querySelectorAll('.tab');
    expect(tabs[0].classList.contains('active')).toBe(false);
    expect(tabs[1].classList.contains('active')).toBe(true);
  });

  it('fires tab-select on click with correct windowId', async () => {
    const windows = [
      makeWindow(1, 'bash'),
      makeWindow(2, 'vim'),
    ];
    el = await fixture(windows);

    const handler = vi.fn();
    el.addEventListener('tab-select', handler);

    const tabs = el.shadowRoot!.querySelectorAll('.tab');
    (tabs[1] as HTMLElement).click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
    expect(event.detail.windowId).toBe(2);
  });

  it('fires tab-new on + button click', async () => {
    el = await fixture([makeWindow(1, 'bash')]);

    const handler = vi.fn();
    el.addEventListener('tab-new', handler);

    const addBtn = el.shadowRoot!.querySelector('.tab-add') as HTMLElement;
    expect(addBtn).toBeTruthy();
    addBtn.click();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
  });
});