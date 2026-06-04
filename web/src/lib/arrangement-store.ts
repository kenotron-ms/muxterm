// Shared composition types used by state.ts.
//
// The arrangement engine (arrange(), ArrangementStore, etc.) and persistence
// layer that formerly lived here were inlined from lib/layout.ts during the
// dockview-core integration and have since been superseded by dockview's own
// panel management. They were removed under YAGNI; the remaining type
// exports support the store's composition projection.

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Device-independent projection of the frozen PaneInfo[]. */
export interface Composition {
  paneIds: number[];
  activePaneId: number;
}
