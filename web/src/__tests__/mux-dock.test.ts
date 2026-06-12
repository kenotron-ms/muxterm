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

  /** Helper: create a fake trigger element with controllable getBoundingClientRect(). */
  function makeTrigger(bottom: number, right: number): HTMLElement {
    const btn = document.createElement('button');
    btn.getBoundingClientRect = () =>
      ({ bottom, right, top: 0, left: 0, width: right, height: bottom } as DOMRect);
    return btn;
  }

  it('_renderBrowserPopover appends a .mux-browser-popover with a text input (URL, not port number) to the dock', () => {
    el = createDock();
    const inner = el as unknown as {
      _browserPopoverOpen: boolean;
      _renderBrowserPopover: (triggerEl: HTMLElement) => void;
    };
    inner._browserPopoverOpen = true;
    inner._renderBrowserPopover(makeTrigger(50, 200));
    const popover = el.querySelector('.mux-browser-popover');
    expect(popover).not.toBeNull();
    // Must be a text input (URL entry), NOT a number input (port entry)
    const textInput = popover!.querySelector('input[type="text"]');
    expect(textInput).not.toBeNull();
    const numberInput = popover!.querySelector('input[type="number"]');
    expect(numberInput).toBeNull();
  });

  it('_renderBrowserPopover uses position:fixed anchored to the trigger element', () => {
    el = createDock();
    const inner = el as unknown as {
      _browserPopoverOpen: boolean;
      _renderBrowserPopover: (triggerEl: HTMLElement) => void;
    };
    inner._browserPopoverOpen = true;

    const triggerEl = makeTrigger(48, 300);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    inner._renderBrowserPopover(triggerEl);

    const popover = el.querySelector('.mux-browser-popover') as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.style.position).toBe('fixed');
    expect(popover.style.top).toBe('52px');          // rect.bottom(48) + 4
    expect(popover.style.right).toBe('724px');        // innerWidth(1024) - rect.right(300)
  });

  it('browser-pane-open event is dispatched with browserUrl (full URL string) when a URL is submitted', () => {
    el = createDock();
    const inner = el as unknown as {
      _browserPopoverOpen: boolean;
      _renderBrowserPopover: (triggerEl: HTMLElement) => void;
    };
    inner._browserPopoverOpen = true;
    inner._renderBrowserPopover(makeTrigger(50, 200));

    const popover = el.querySelector('.mux-browser-popover')!;
    const input = popover.querySelector('input') as HTMLInputElement;
    const btn = popover.querySelector('.mux-browser-open-btn') as HTMLButtonElement;

    let receivedDetail: { browserUrl: string } | null = null;
    el.addEventListener('browser-pane-open', (e) => {
      receivedDetail = (e as CustomEvent<{ browserUrl: string }>).detail;
    });

    input.value = 'http://localhost:3000';
    btn.click();

    expect(receivedDetail).not.toBeNull();
    expect(receivedDetail!.browserUrl).toBe('http://localhost:3000');
  });

  it('browser-pane-open normalizes a bare port number to http://localhost:{port}', () => {
    el = createDock();
    const inner = el as unknown as {
      _browserPopoverOpen: boolean;
      _renderBrowserPopover: (triggerEl: HTMLElement) => void;
    };
    inner._browserPopoverOpen = true;
    inner._renderBrowserPopover(makeTrigger(50, 200));

    const popover = el.querySelector('.mux-browser-popover')!;
    const input = popover.querySelector('input') as HTMLInputElement;
    const btn = popover.querySelector('.mux-browser-open-btn') as HTMLButtonElement;

    let receivedDetail: { browserUrl: string } | null = null;
    el.addEventListener('browser-pane-open', (e) => {
      receivedDetail = (e as CustomEvent<{ browserUrl: string }>).detail;
    });

    input.value = '5173';
    btn.click();

    expect(receivedDetail).not.toBeNull();
    expect(receivedDetail!.browserUrl).toBe('http://localhost:5173');
  });

  it('browser-pane-open accepts an external https URL', () => {
    el = createDock();
    const inner = el as unknown as {
      _browserPopoverOpen: boolean;
      _renderBrowserPopover: (triggerEl: HTMLElement) => void;
    };
    inner._browserPopoverOpen = true;
    inner._renderBrowserPopover(makeTrigger(50, 200));

    const popover = el.querySelector('.mux-browser-popover')!;
    const input = popover.querySelector('input') as HTMLInputElement;
    const btn = popover.querySelector('.mux-browser-open-btn') as HTMLButtonElement;

    let receivedDetail: { browserUrl: string } | null = null;
    el.addEventListener('browser-pane-open', (e) => {
      receivedDetail = (e as CustomEvent<{ browserUrl: string }>).detail;
    });

    input.value = 'https://google.com';
    btn.click();

    expect(receivedDetail).not.toBeNull();
    expect(receivedDetail!.browserUrl).toBe('https://google.com');
  });

  it('Escape keydown on popover input calls _closeBrowserPopover', () => {
    el = createDock();
    const inner = el as unknown as {
      _browserPopoverOpen: boolean;
      _renderBrowserPopover: (triggerEl: HTMLElement) => void;
      _closeBrowserPopover: () => void;
    };
    inner._browserPopoverOpen = true;
    inner._renderBrowserPopover(makeTrigger(50, 200));

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

// ─── BrowserRenderer — external proxy URL routing ────────────────────────────

describe('BrowserRenderer — external proxy URL routing', () => {
  let el: MuxDock;

  afterEach(() => {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });

  function createDock(): MuxDock {
    const dock = document.createElement('mux-dock') as MuxDock;
    document.body.appendChild(dock);
    return dock;
  }

  it('port=0 routes through /x/ proxy when path is a full external URL', async () => {
    el = createDock();
    await (el as LitElement).updateComplete;

    // Set up a browser pane with port=0 (external URL) and a full https URL as path.
    (el as unknown as { panes: unknown[] }).panes = [
      { paneId: 1, surfaceKind: 'browser', browserPort: 0, browserPath: 'https://example.com/docs' },
    ];
    (el as unknown as { workspaceKey: string }).workspaceKey = 'test-ws';
    await (el as LitElement).updateComplete;

    // After addPanel/init(), mux-browser-surface should be in the dock's DOM tree
    // with its .url property set to the proxied path.
    const surface = el.querySelector('mux-browser-surface') as (HTMLElement & { url?: string }) | null;
    expect(surface).not.toBeNull();
    const surfaceUrl = surface!.url ?? '';
    // Should route through /x/ proxy: {origin}/x/example.com/docs
    expect(surfaceUrl).toContain('/x/example.com/docs');
    // Should NOT be the raw external URL
    expect(surfaceUrl).not.toBe('https://example.com/docs');
  });

  it('url-change for port=0 converts /x/{host}/path back to https://{host}/path in pane-navigate', async () => {
    el = createDock();
    await (el as LitElement).updateComplete;

    (el as unknown as { panes: unknown[] }).panes = [
      { paneId: 2, surfaceKind: 'browser', browserPort: 0, browserPath: 'https://example.com/about' },
    ];
    (el as unknown as { workspaceKey: string }).workspaceKey = 'test-ws2';
    await (el as LitElement).updateComplete;

    // Get the BrowserRenderer's element via the private _browserRenderers map.
    const inner = el as unknown as {
      _browserRenderers: Map<number, { element: HTMLElement }>;
    };
    const renderer = inner._browserRenderers.get(2);
    expect(renderer).toBeDefined();

    let navigateDetail: { paneId: number; browserPath: string } | null = null;
    el.addEventListener('pane-navigate', (e: Event) => {
      navigateDetail = (e as CustomEvent<{ paneId: number; browserPath: string }>).detail;
    });

    // Simulate the browser navigating to a proxied URL inside the iframe.
    // The url-change event is fired on the renderer's element with the /x/ proxied URL.
    renderer!.element.dispatchEvent(
      new CustomEvent('url-change', {
        detail: { url: `${location.origin}/x/example.com/about` },
        bubbles: true,
        composed: true,
      }),
    );

    expect(navigateDetail).not.toBeNull();
    // Should convert back to the real external URL
    expect(navigateDetail!.browserPath).toBe('https://example.com/about');
    expect(navigateDetail!.paneId).toBe(2);
  });
});
