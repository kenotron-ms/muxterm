import type {
  SessiondMessage,
  SessiondWorkspaceInfo,
  SessiondPaneInfo,
} from './types';
import { SessiondType } from './types';
import type { Composition } from './lib/layout.js';
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from './lib/config.js';

// --- optimistic-mutation seam -----------------------------------------------
// A pending mutation overlays an optimistic patch over a COPY of the
// authoritative base; the base is never mutated. Getters fold the pending
// overlay over a fresh copy of the base, recomputed on every read.

// Mutable working copy the optimistic patch edits.
export interface MutationDraft {
  workspaces: SessiondWorkspaceInfo[];
  panes: SessiondPaneInfo[];
}

// Read-only authoritative snapshot the settle predicate inspects.
export interface MutationBase {
  readonly workspaces: readonly SessiondWorkspaceInfo[];
  readonly panes: readonly SessiondPaneInfo[];
}

export interface MutationSpec {
  // Patch applied over a copy of the base while pending and not errored.
  optimistic: (draft: MutationDraft) => void;
  // True once the authoritative base reflects this mutation.
  settled: (base: MutationBase) => boolean;
  // Fires the socket send; called on mutate() and again on retry().
  commit?: () => void;
  onTimeout?: () => void;
  workspaceId?: string;
  kind?: string;
  timeoutMs?: number;
}

export interface ErroredMutation {
  id: string;
  workspaceId?: string;
  kind?: string;
}

export interface PendingRecord extends MutationSpec {
  id: string;
  errored: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_MUTATION_TIMEOUT_MS = 5000;

export class MuxStore {
  private _listeners: Set<() => void> = new Set();
  private _config: ResolvedConfig = DEFAULT_RESOLVED_CONFIG;

  // --- sessiond multiplexer path --------------------------------------------
  // Frozen wire state for the sessiond control protocol. A pure Composition is
  // projected from _panes for the layout engine.
  private _workspaces: SessiondWorkspaceInfo[] = [];
  private _attached: string | null = null;
  private _panes: SessiondPaneInfo[] = [];
  private _activePaneId = 0;
  private _pending: Map<string, PendingRecord> = new Map();
  private _mutationSeq = 0;

  get config(): ResolvedConfig {
    return this._config;
  }

  setConfig(cfg: ResolvedConfig): void {
    this._config = cfg;
    this._notify();
  }

  get workspaces(): SessiondWorkspaceInfo[] {
    // Fold the pending optimistic overlay over a fresh copy of the base.
    return this._foldedView().workspaces;
  }

  get attached(): string | null {
    return this._attached;
  }

  get panes(): SessiondPaneInfo[] {
    // Fold the pending optimistic overlay over a fresh copy of the base.
    return this._foldedView().panes;
  }

  // Pure device-independent projection of the frozen PaneInfo[] for the layout
  // engine. Keeps lib/layout.ts free of wire types.
  get composition(): Composition {
    return {
      paneIds: this._foldedView().panes.map((p) => p.paneId),
      activePaneId: this._activePaneId,
    };
  }

  get erroredMutations(): ErroredMutation[] {
    const out: ErroredMutation[] = [];
    for (const record of this._pending.values()) {
      if (record.errored) {
        out.push({
          id: record.id,
          workspaceId: record.workspaceId,
          kind: record.kind,
        });
      }
    }
    return out;
  }

  setActivePane(paneId: number): void {
    if (this._activePaneId === paneId) return;
    this._activePaneId = paneId;
    this._notify();
  }

  // Apply a sessiond control-protocol message. Workspace and composition state
  // are reconciled idempotently so actor + broadcast echoes of the same event
  // converge to one truth.
  applySessiond(msg: SessiondMessage): void {
    switch (msg.type) {
      case SessiondType.WorkspaceList:
        this._workspaces = msg.workspaces ?? [];
        break;

      // composition reply: binds us to a workspace and replaces panes wholesale.
      case SessiondType.Composition: {
        this._attached = msg.workspaceId ?? null;
        this._panes = [...(msg.panes ?? [])];
        this._activePaneId = this._panes[0]?.paneId ?? 0;
        break;
      }

      case SessiondType.PaneAdded: {
        if (this._attached === null) break;
        const paneId = msg.paneId ?? 0;
        // Idempotent: actor and broadcast both deliver this event.
        if (this._panes.some((p) => p.paneId === paneId)) break;
        this._panes.push({
          paneId,
          cols: msg.cols ?? 0,
          rows: msg.rows ?? 0,
          title: msg.title,
        });
        break;
      }

      case SessiondType.PaneClosed: {
        // Ignore trailing pane-closed after we've detached (workspace-closed).
        if (this._attached === null) break;
        const paneId = msg.paneId ?? 0;
        this._panes = this._panes.filter((p) => p.paneId !== paneId);
        if (this._activePaneId === paneId) {
          this._activePaneId = this._panes[0]?.paneId ?? 0;
        }
        break;
      }

      case SessiondType.WorkspaceClosed: {
        const workspaceId = msg.workspaceId ?? null;
        this._workspaces = this._workspaces.filter(
          (w) => w.workspaceId !== workspaceId,
        );
        if (this._attached === workspaceId) {
          this._attached = null;
          this._panes = [];
          this._activePaneId = 0;
        }
        break;
      }

      case SessiondType.WorkspaceRenamed: {
        this._workspaces = this._workspaces.map((w) =>
          w.workspaceId === msg.workspaceId
            ? { ...w, name: msg.name ? msg.name : undefined }
            : w,
        );
        break;
      }

      default:
        return; // unhandled type: no state change, no notify
    }
    this._settlePending();
    this._notify();
  }

  // Fold the pending optimistic overlay over a fresh COPY of the authoritative
  // base. The base is never mutated; this is recomputed on every read.
  private _foldedView(): MutationDraft {
    const draft: MutationDraft = {
      workspaces: this._workspaces.map((w) => ({ ...w })),
      panes: this._panes.map((p) => ({ ...p })),
    };
    for (const record of this._pending.values()) {
      if (record.errored) continue;
      record.optimistic(draft);
    }
    return draft;
  }

  // After the authoritative base updates, drop any pending mutation whose
  // settled(base) predicate is now true so its overlay vanishes and the correct
  // base shows through. Errored records are left for the user to retry/dismiss.
  private _settlePending(): void {
    const base: MutationBase = {
      workspaces: this._workspaces,
      panes: this._panes,
    };
    for (const record of this._pending.values()) {
      if (record.errored) continue;
      if (record.settled(base)) {
        if (record.timer !== undefined) clearTimeout(record.timer);
        this._pending.delete(record.id);
      }
    }
  }

  mutate(spec: MutationSpec): string {
    const id = `m${++this._mutationSeq}`;
    const record: PendingRecord = {
      ...spec,
      id,
      errored: false,
      timer: undefined,
    };
    record.timer = setTimeout(
      () => this._onMutationTimeout(id),
      spec.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS,
    );
    this._pending.set(id, record);
    spec.commit?.();
    this._notify();
    return id;
  }

  dismiss(id: string): void {
    const record = this._pending.get(id);
    if (!record) return;
    if (record.timer !== undefined) clearTimeout(record.timer);
    this._pending.delete(id);
    this._notify();
  }

  retry(id: string): void {
    const record = this._pending.get(id);
    if (!record) return;
    record.errored = false;
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.timer = setTimeout(
      () => this._onMutationTimeout(id),
      record.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS,
    );
    record.commit?.();
    this._notify();
  }

  private _onMutationTimeout(id: string): void {
    const record = this._pending.get(id);
    if (!record || record.errored) return;
    record.errored = true;
    record.timer = undefined;
    record.onTimeout?.();
    this._notify();
  }

  subscribe(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  private _notify(): void {
    for (const cb of this._listeners) {
      cb();
    }
  }
}

export const store = new MuxStore();