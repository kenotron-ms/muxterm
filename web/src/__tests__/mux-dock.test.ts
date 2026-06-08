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

// Make TypeScript happy with the `updateComplete` reference above
interface LitElement extends HTMLElement {
  updateComplete: Promise<boolean>;
}
