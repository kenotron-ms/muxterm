// Per-(workspace, viewport) arrangement persistence.
//
// Layout preferences are stored in localStorage keyed by the STABLE, opaque
// workspaceId so renaming a workspace's display name never loses its layout.
// Saved state holds only what cannot be recomputed (peer order + active pane);
// everything else (visibility, mode) is derived from the live composition via
// the pure arrange() engine.

import { arrange, type Arrangement, type Composition, type ViewportClass } from './layout.js';

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
