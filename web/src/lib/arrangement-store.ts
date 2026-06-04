// Per-(workspace, viewport) arrangement persistence.
//
// Layout preferences are stored in localStorage keyed by the STABLE, opaque
// workspaceId so renaming a workspace's display name never loses its layout.
// Saved state holds only what cannot be recomputed (peer order + active pane);
// everything else (visibility, mode) is derived from the live composition via
// the pure arrange() engine.
//
// Types and arrange() engine formerly in lib/layout.ts; inlined here after the
// composition stack was replaced with dockview-core.

// ---------------------------------------------------------------------------
// Viewport classification
// ---------------------------------------------------------------------------

export type ViewportClass = 'wide' | 'medium' | 'narrow';

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Device-independent projection of the frozen PaneInfo[]. */
export interface Composition {
  paneIds: number[];
  activePaneId: number;
}

// ---------------------------------------------------------------------------
// Arrangement engine
// ---------------------------------------------------------------------------

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
const MAX_VISIBLE: Record<ViewportClass, number> = {
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

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Persisted arrangement state: only the bits arrange() cannot recompute. */
export interface SavedArrangement {
  order: number[];
  activePaneId: number;
}

const KEY_PREFIX = 'muxterm.arrangement';

/** localStorage key for a (workspaceId, viewport profile) pair. */
export function storageKey(workspaceId: string, profile: ViewportClass): string {
  return `${KEY_PREFIX}.${workspaceId}.${profile}`;
}

export class ArrangementStore {
  /** Persist saved arrangement; quota/private-mode failures are non-fatal. */
  save(workspaceId: string, profile: ViewportClass, saved: SavedArrangement): void {
    try {
      localStorage.setItem(storageKey(workspaceId, profile), JSON.stringify(saved));
    } catch {
      // Quota exceeded or storage unavailable (private mode): ignore.
    }
  }

  /**
   * Load the arrangement for a composition, reconciling any saved preference
   * against the live composition. Falls back to the responsive default when
   * nothing valid is saved.
   */
  load(workspaceId: string, profile: ViewportClass, composition: Composition): Arrangement {
    const saved = this._read(workspaceId, profile);
    if (saved === null) {
      return arrange(composition, profile);
    }

    const live = new Set(composition.paneIds);

    // (1) Keep saved entries still present in the live composition, in saved order.
    const order = saved.order.filter((id) => live.has(id));

    // (2) Append newly-composed pane ids not already in saved order.
    const inOrder = new Set(order);
    for (const id of composition.paneIds) {
      if (!inOrder.has(id)) order.push(id);
    }

    // (3) Resolve active: saved active if still present, else composition's.
    const activePaneId = order.includes(saved.activePaneId)
      ? saved.activePaneId
      : composition.activePaneId;

    return arrange({ paneIds: order, activePaneId }, profile);
  }

  /** Parse saved state; returns null on missing/malformed entries. */
  private _read(workspaceId: string, profile: ViewportClass): SavedArrangement | null {
    try {
      const raw = localStorage.getItem(storageKey(workspaceId, profile));
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as SavedArrangement;
      if (!Array.isArray(parsed.order)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}
