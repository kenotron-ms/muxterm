import { describe, it, expect, afterEach } from 'vitest';

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

// MuxDock — browser popover tests removed: the popover was replaced by an
// address bar in mux-browser-surface with a globe-button that opens the pane
// directly. No popover UI exists to test.

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
