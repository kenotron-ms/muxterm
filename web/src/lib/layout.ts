// Responsive viewport classification for the browser multiplexer.
//
// Breakpoints borrow from responsive web design:
//   wide   (desktop/ultrawide) = tiling, all peers visible
//   medium (tablet/laptop)     = tiling, fewer simultaneous splits
//   narrow (phone/portrait)    = tabbed, one peer visible
//
// Pure logic only: nothing here touches the DOM, localStorage, or network.

export type ViewportClass = 'wide' | 'medium' | 'narrow';

/** Lower bounds, in CSS pixels, for each viewport class. */
export const BREAKPOINTS = {
  WIDE_MIN: 1024,
  MEDIUM_MIN: 640,
} as const;

/** Classify a viewport width (CSS px) into a responsive layout class. */
export function viewportClassFor(widthPx: number): ViewportClass {
  if (widthPx >= BREAKPOINTS.WIDE_MIN) return 'wide';
  if (widthPx >= BREAKPOINTS.MEDIUM_MIN) return 'medium';
  return 'narrow';
}

// --- Arrangement engine ------------------------------------------------------
//
// Panes are peers (no master/stack hierarchy). The store keeps the full,
// device-specific SessiondPaneInfo[] and projects a Composition here so this
// module stays pure and free of wire types.

/** Device-independent projection of the frozen PaneInfo[]. */
export interface Composition {
  paneIds: number[];
  activePaneId: number;
}

/** How panes are presented: side-by-side tiles or one-at-a-time tabs. */
export type ArrangementMode = 'tiling' | 'tabbed';

/** Result of arranging a composition for a viewport class. */
export interface Arrangement {
  mode: ArrangementMode;
  order: number[];
  visible: number[];
  active: number | null;
}

/** Maximum number of simultaneously visible panes per viewport class. */
export const MAX_VISIBLE: Record<ViewportClass, number> = {
  wide: Infinity,
  medium: 2,
  narrow: 1,
};

/**
 * Arrange a composition for a viewport class.
 *
 * Panes are peers; order is preserved. The active pane is always visible.
 * Wide tiles every pane, medium tiles at most two, narrow tabs to a single
 * pane. Visible panes are re-sorted into stable peer order for deterministic
 * rendering.
 */
export function arrange(composition: Composition, viewportClass: ViewportClass): Arrangement {
  const order = [...composition.paneIds];
  const mode: ArrangementMode = viewportClass === 'narrow' ? 'tabbed' : 'tiling';

  if (order.length === 0) {
    return { mode, order: [], visible: [], active: null };
  }

  const active = order.includes(composition.activePaneId) ? composition.activePaneId : order[0];

  const cap = Math.min(MAX_VISIBLE[viewportClass], order.length);
  const startIndex = order.indexOf(active);

  const chosen = new Set<number>();
  for (let i = 0; i < cap; i++) {
    chosen.add(order[(startIndex + i) % order.length]);
  }

  // Re-sort visible into stable peer (order) sequence for deterministic render.
  const visible = order.filter((id) => chosen.has(id));

  return { mode, order, visible, active };
}
