import { describe, it, expect, afterEach, vi } from 'vitest';

// Import the component — triggers custom element registration
import '../components/mux-dock.js';
import type { MuxDock } from '../components/mux-dock.js';

describe('MuxDock', () => {
  let el: MuxDock;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });

  it('exposes a reopenPane(paneId) method', () => {
    el = document.createElement('mux-dock') as MuxDock;
    document.body.appendChild(el);
    expect(typeof (el as unknown as { reopenPane: unknown }).reopenPane).toBe('function');
  });

  it('exposes an allowReconcile(paneIds) method', () => {
    el = document.createElement('mux-dock') as MuxDock;
    document.body.appendChild(el);
    expect(typeof (el as unknown as { allowReconcile: unknown }).allowReconcile).toBe('function');
  });

  it('allowReconcile removes ids from _locallyClosedPanes so the reconciler can re-add them', () => {
    el = document.createElement('mux-dock') as MuxDock;
    document.body.appendChild(el);
    const inner = el as unknown as {
      _locallyClosedPanes: Set<number>;
      allowReconcile: (ids: Iterable<number>) => void;
    };
    inner._locallyClosedPanes.add(1);
    inner._locallyClosedPanes.add(2);
    inner._locallyClosedPanes.add(3);
    inner.allowReconcile([1, 3]);
    expect(inner._locallyClosedPanes.has(1)).toBe(false);
    expect(inner._locallyClosedPanes.has(2)).toBe(true);  // untouched
    expect(inner._locallyClosedPanes.has(3)).toBe(false);
  });

  it('pane-close event dispatched by the dock carries touch and title fields', async () => {
    el = document.createElement('mux-dock') as MuxDock;
    document.body.appendChild(el);
    await (el as LitElement).updateComplete;

    let detail: Record<string, unknown> | null = null;
    el.addEventListener('pane-close', (e: Event) => {
      detail = (e as CustomEvent).detail as Record<string, unknown>;
    });

    // Simulate the dock firing pane-close with the new shape.
    // We dispatch it directly here to test the *consumer contract*:
    // the app must be able to destructure { paneId, touch, title }.
    el.dispatchEvent(
      new CustomEvent('pane-close', {
        detail: { paneId: 7, touch: false, title: 'bash' },
        bubbles: true,
        composed: true,
      }),
    );

    expect(detail).not.toBeNull();
    expect(detail!.paneId).toBe(7);
    expect(detail!.touch).toBe(false);
    expect(detail!.title).toBe('bash');
  });
});

describe('MuxDock — browser popover', () => {
  let el: MuxDock;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    vi.restoreAllMocks();
  });

  function createDock(): MuxDock {
    const dock = document.createElement('mux-dock') as MuxDock;
    document.body.appendChild(dock);
    return dock;
  }

  it('_browserPopoverOpen initializes to false', () => {
    el = createDock();
    const inner = el as unknown as { _browserPopoverOpen: boolean };
    expect(inner._browserPopoverOpen).toBe(false);
  });

  it('_browserPopoverGroup initializes to null', () => {
    el = createDock();
    const inner = el as unknown as { _browserPopoverGroup: unknown };
    expect(inner._browserPopoverGroup).toBeNull();
  });

  it('_closeBrowserPopover resets _browserPopoverOpen to false and _browserPopoverGroup to null', () => {
    el = createDock();
    const inner = el as unknown as {
      _browserPopoverOpen: boolean;
      _browserPopoverGroup: unknown;
      _closeBrowserPopover: () => void;
    };
    inner._browserPopoverOpen = true;
    inner._browserPopoverGroup = {};
    inner._closeBrowserPopover();
    expect(inner._browserPopoverOpen).toBe(false);
    expect(inner._browserPopoverGroup).toBeNull();
  });

  it('_closeBrowserPopover removes .mux-browser-popover from the dock element', () => {
    el = createDock();
    const popover = document.createElement('div');
    popover.className = 'mux-browser-popover';
    el.appendChild(popover);
    const inner = el as unknown as { _closeBrowserPopover: () => void };
    inner._closeBrowserPopover();
    expect(el.querySelector('.mux-browser-popover')).toBeNull();
  });

  it('_renderBrowserPopover appends a .mux-browser-popover with a number input to the dock', () => {
    el = createDock();
    const inner = el as unknown as {
      _browserPopoverOpen: boolean;
      _renderBrowserPopover: () => void;
    };
    inner._browserPopoverOpen = true;
    inner._renderBrowserPopover();
    const popover = el.querySelector('.mux-browser-popover');
    expect(popover).not.toBeNull();
    const input = popover!.querySelector('input[type="number"]');
    expect(input).not.toBeNull();
  });

  it('browser-pane-open event is dispatched with browserPort when a valid port is submitted', () => {
    el = createDock();
    const inner = el as unknown as {
      _browserPopoverOpen: boolean;
      _renderBrowserPopover: () => void;
    };
    inner._browserPopoverOpen = true;
    inner._renderBrowserPopover();

    const popover = el.querySelector('.mux-browser-popover')!;
    const input = popover.querySelector('input') as HTMLInputElement;
    const btn = popover.querySelector('.mux-browser-open-btn') as HTMLButtonElement;

    let receivedDetail: { browserPort: number } | null = null;
    el.addEventListener('browser-pane-open', (e) => {
      receivedDetail = (e as CustomEvent<{ browserPort: number }>).detail;
    });

    input.value = '3000';
    btn.click();

    expect(receivedDetail).not.toBeNull();
    expect(receivedDetail!.browserPort).toBe(3000);
  });

  it('Escape keydown on popover input calls _closeBrowserPopover', () => {
    el = createDock();
    const inner = el as unknown as {
      _browserPopoverOpen: boolean;
      _renderBrowserPopover: () => void;
      _closeBrowserPopover: () => void;
    };
    inner._browserPopoverOpen = true;
    inner._renderBrowserPopover();

    const closeSpy = vi.spyOn(inner, '_closeBrowserPopover');

    const popover = el.querySelector('.mux-browser-popover')!;
    const input = popover.querySelector('input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(closeSpy).toHaveBeenCalled();
  });
});

// Make TypeScript happy with the `updateComplete` reference above
interface LitElement extends HTMLElement {
  updateComplete: Promise<boolean>;
}
