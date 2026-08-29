import type {
  SessiondMessage,
  SessiondPaneRecoveryInfo,
  SessiondWorkspaceInfo,
  SessiondPaneInfo,
} from './types';
import { SessiondRecoveryType, SessiondType } from './types';
import type { Composition } from './lib/arrangement-store.js';
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from './lib/config.js';
import { DEFAULT_AI_STATUS, type AIStatus } from './lib/ai.js';
import { muxLog } from './lib/mux-log.js';
import { validateRecoveryProjection, type RecoveryWireEvent } from './recovery-wire.js';

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

function isAttachedPaneID(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
}

function sameRecovery(
  left: SessiondPaneRecoveryInfo | undefined,
  right: SessiondPaneRecoveryInfo,
): boolean {
  if (!left) return false;
  if (
    left.status !== right.status ||
    left.detailCode !== right.detailCode ||
    left.historyBoundary !== right.historyBoundary ||
    left.canRetry !== right.canRetry ||
    left.canSelect !== right.canSelect ||
    left.strategyLabel !== right.strategyLabel
  ) {
    return false;
  }
  const leftCandidates = left.status === 'selection-needed' ? left.selectionCandidates : [];
  const rightCandidates = right.status === 'selection-needed' ? right.selectionCandidates : [];
  return (
    leftCandidates.length === rightCandidates.length &&
    leftCandidates.every(
      (candidate, index) =>
        candidate.candidateHandle === rightCandidates[index]?.candidateHandle &&
        candidate.strategyLabel === rightCandidates[index]?.strategyLabel,
    )
  );
}

function copyPaneWithValidatedRecovery(pane: SessiondPaneInfo): SessiondPaneInfo {
  const copy: SessiondPaneInfo = { ...pane };
  const recovery =
    isAttachedPaneID(pane.paneId) ? validateRecoveryProjection(pane.recovery) : null;
  if (recovery === null) {
    delete copy.recovery;
  } else {
    copy.recovery = recovery;
  }
  return copy;
}

export class MuxStore {
  private _listeners: Set<() => void> = new Set();
  private _config: ResolvedConfig = DEFAULT_RESOLVED_CONFIG;
  // Opt-in AI capability. Deliberately NOT part of _config: the key that backs
  // this flag never enters the config pipeline, and neither does the flag.
  private _aiStatus: AIStatus = DEFAULT_AI_STATUS;

  // --- sessiond multiplexer path --------------------------------------------
  // Frozen wire state for the sessiond control protocol. A pure Composition is
  // projected from _panes for the layout engine.
  private _workspaces: SessiondWorkspaceInfo[] = [];
  private _attached: string | null = null;
  private _panes: SessiondPaneInfo[] = [];
  private _activePaneId = 0;
  private _layout = '';
  private _pending: Map<string, PendingRecord> = new Map();
  private _mutationSeq = 0;
  /** Workspace IDs that have an unacknowledged activity bell. */
  private _bellWorkspaces: Set<string> = new Set();
  /** Pane IDs that have an unacknowledged activity bell. */
  private _bellPanes: Set<number> = new Set();


  get config(): ResolvedConfig {
    return this._config;
  }

  get layout(): string {
    return this._layout;
  }

  setConfig(cfg: ResolvedConfig): void {
    this._config = cfg;
    this._notify();
  }

  get aiStatus(): AIStatus {
    return this._aiStatus;
  }

  /**
   * The single frontend gate for all future AI UI. Updated from
   * GET /api/ai/status on load and from the {"aiStatus":...} WS frame when
   * a key is saved or cleared in any tab.
   */
  setAIStatus(status: AIStatus): void {
    this._aiStatus = status;
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
  get activePaneId(): number {
    return this._activePaneId;
  }

  get composition(): Composition {
    return {
      // Exclude provisional overlay panes (negative IDs) from the layout so
      // no blank tile appears while waiting for the real pane-added echo.
      paneIds: this._foldedView().panes.filter((p) => p.paneId >= 0).map((p) => p.paneId),
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

  hasPendingKind(kind: string): boolean {
    for (const record of this._pending.values()) {
      if (!record.errored && record.kind === kind) return true;
    }
    return false;
  }

  /** Returns true if the workspace has an unacknowledged activity bell. */
  workspaceBellActive(wsId: string): boolean {
    return this._bellWorkspaces.has(wsId);
  }

  /**
   * Acknowledge (clear) the activity bell for a workspace.
   * Notifies subscribers so bell indicators are removed immediately.
   */
  ackWorkspace(wsId: string): void {
    if (!this._bellWorkspaces.has(wsId)) return;
    this._bellWorkspaces.delete(wsId);
    this._notify();
  }

  /** Returns true if the pane has an unacknowledged activity bell. */
  paneBellActive(paneId: number): boolean {
    return this._bellPanes.has(paneId);
  }

  /**
   * Acknowledge (clear) the activity bell for a pane.
   * Notifies subscribers so bell indicators are removed immediately.
   */
  ackPane(paneId: number): void {
    if (!this._bellPanes.has(paneId)) return;
    this._bellPanes.delete(paneId);
    this._notify();
  }

  /**
   * Ring the activity bell for a pane.
   * Notifies subscribers so bell indicators appear immediately.
   */
  ringPane(paneId: number): void {
    this._bellPanes.add(paneId);
    this._notify();
  }

  /**
   * Ring the activity bell for a workspace.
   * Notifies subscribers so bell indicators appear immediately.
   */
  ringWorkspace(workspaceId: string): void {
    this._bellWorkspaces.add(workspaceId);
    this._notify();
  }

  setActivePane(paneId: number): void {
    if (
      this._attached === null ||
      !isAttachedPaneID(paneId) ||
      !this._panes.some((pane) => pane.paneId === paneId)
    ) {
      return;
    }
    if (this._activePaneId === paneId) return;
    muxLog('state active', `setActivePane ${this._activePaneId} → ${paneId}`);
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
        // Prune stale workspace bell entries for workspaces that no longer exist.
        for (const wsId of this._bellWorkspaces) {
          if (!this._workspaces.some((w) => w.workspaceId === wsId)) {
            this._bellWorkspaces.delete(wsId);
          }
        }
        // If the currently attached workspace was removed, clear attachment state.
        if (this._attached !== null && !this._workspaces.some(w => w.workspaceId === this._attached)) {
          this._clearAttachmentState();
        }
        break;

      // composition reply: binds us to a workspace and replaces panes wholesale.
      case SessiondType.Composition: {
        if (typeof msg.workspaceId !== 'string' || msg.workspaceId.length === 0) {
          this._clearAttachmentState();
          break;
        }
        this._attached = msg.workspaceId;
        this._panes = (Array.isArray(msg.panes) ? msg.panes : []).map(copyPaneWithValidatedRecovery);
        const newActivePaneId = this._panes[0]?.paneId ?? 0;
        muxLog('state composition', `activePaneId set to panes[0]=${newActivePaneId}`,
          { paneIds: this._panes.map(p => p.paneId), prevActive: this._activePaneId });
        this._activePaneId = newActivePaneId;
        this._layout = msg.layout ?? '';
        break;
      }

      case SessiondType.PaneAdded: {
        if (
          this._attached === null ||
          msg.workspaceId !== this._attached ||
          !isAttachedPaneID(msg.paneId)
        ) {
          break;
        }
        const paneId = msg.paneId;
        // Idempotent: actor and broadcast both deliver this event.
        if (this._panes.some((p) => p.paneId === paneId)) break;
        const recovery = validateRecoveryProjection(msg.recovery);
        const pane: SessiondPaneInfo = {
          paneId,
          cols: msg.cols ?? 0,
          rows: msg.rows ?? 0,
          title: msg.title,
          clientRef: msg.clientRef,
          surfaceKind: msg.surfaceKind,
        };
        if (recovery !== null) pane.recovery = recovery;
        this._panes.push(pane);
        break;
      }

      case SessiondType.PaneClosed: {
        // Ignore trailing pane-closed after we've detached (workspace-closed).
        if (
          this._attached === null ||
          msg.workspaceId !== this._attached ||
          !isAttachedPaneID(msg.paneId)
        ) {
          break;
        }
        const paneId = msg.paneId;
        this._panes = this._panes.filter((p) => p.paneId !== paneId);
        this._bellPanes.delete(paneId);
        if (this._activePaneId === paneId) {
          this._activePaneId = this._panes[0]?.paneId ?? 0;
        }
        break;
      }

      case SessiondType.WorkspaceClosed: {
        if (typeof msg.workspaceId !== 'string' || msg.workspaceId.length === 0) break;
        this._workspaces = this._workspaces.filter((workspace) => workspace.workspaceId !== msg.workspaceId);
        this._bellWorkspaces.delete(msg.workspaceId);
        if (this._attached === msg.workspaceId) this._clearAttachmentState();
        break;
      }

      case SessiondType.WorkspaceCreated: {
        // Idempotent: actor + broadcast echoes of the same event converge to one
        // entry.  Mirror the PaneAdded guard style.
        if (typeof msg.workspaceId !== 'string' || msg.workspaceId.length === 0) break;
        if (this._workspaces.some((w) => w.workspaceId === msg.workspaceId)) break;
        this._workspaces = [
          ...this._workspaces,
          {
            workspaceId: msg.workspaceId,
            name: msg.name ? msg.name : undefined,
            clientRef: msg.clientRef,
            paneCount: 0,
          },
        ];
        break;
      }

      case SessiondType.PaneRenamed: {
        if (
          this._attached === null ||
          (msg.workspaceId !== undefined && msg.workspaceId !== this._attached) ||
          !isAttachedPaneID(msg.paneId)
        ) {
          break;
        }
        const paneId = msg.paneId;
        const p = this._panes.find((x) => x.paneId === paneId);
        if (p) p.title = msg.name;
        break;
      }

      default:
        return; // unhandled type: no state change, no notify
    }
    this._settlePending();
    this._notify();
  }

  /**
   * Recovery events already passed the recovery-wire trust boundary. Results
   * may update only a pane in the currently attached workspace, never a bare
   * pane ID that might name a pane in another workspace.
   */
  applyRecovery(event: RecoveryWireEvent): void {
    let changed = false;
    switch (event.type) {
      case SessiondRecoveryType.PaneRecoveryChanged:
        changed = this._replaceRecovery(event.recoveryTransition.pane, event.recoveryTransition.recovery);
        break;
      case SessiondRecoveryType.RecoveryRetryResult:
        changed = this._replaceRecovery(event.recoveryRetryResult.pane, event.recoveryRetryResult.recovery);
        break;
      case SessiondRecoveryType.RecoverySelectResult:
        changed = this._replaceRecovery(event.recoverySelectResult.pane, event.recoverySelectResult.recovery);
        break;
      case SessiondRecoveryType.SetActivePaneResult: {
        const result = event.activePanePersistenceResult;
        if (
          result.detailCode === 'none' &&
          this._attached === result.pane.workspaceId &&
          this._panes.some((pane) => pane.paneId === result.pane.paneId) &&
          this._activePaneId !== result.pane.paneId
        ) {
          this._activePaneId = result.pane.paneId;
          changed = true;
        }
        break;
      }
      case SessiondRecoveryType.ProtocolHelloResult:
      case SessiondRecoveryType.ReplacementOutcome:
        break;
    }
    if (changed) this._notify();
  }

  /** Remove only recovery projections when the transport becomes untrusted. */
  clearRecoveryOnTransportLoss(): void {
    let changed = false;
    const panes = this._panes.map((pane) => {
      if (pane.recovery === undefined) return pane;
      changed = true;
      const { recovery: _recovery, ...withoutRecovery } = pane;
      return withoutRecovery;
    });
    if (!changed) return;
    this._panes = panes;
    this._notify();
  }

  /** Clear every attachment-scoped value after a detached control message. */
  detach(): void {
    if (!this._clearAttachmentState()) return;
    this._notify();
  }

  // Fold the pending optimistic overlay over a fresh COPY of the authoritative
  // base. The base is never mutated; this is recomputed on every read.
  private _foldedView(): MutationDraft {
    const draft: MutationDraft = {
      workspaces: this._workspaces.map((w) => ({ ...w })),
      panes: this._panes.map(copyPaneWithValidatedRecovery),
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

  private _replaceRecovery(
    pane: { workspaceId: string; paneId: number },
    recoveryValue: unknown,
  ): boolean {
    if (this._attached !== pane.workspaceId || !isAttachedPaneID(pane.paneId)) return false;
    const recovery = validateRecoveryProjection(recoveryValue);
    if (recovery === null) return false;
    const index = this._panes.findIndex((entry) => entry.paneId === pane.paneId);
    if (index < 0 || sameRecovery(this._panes[index]?.recovery, recovery)) return false;
    const panes = [...this._panes];
    panes[index] = { ...panes[index], recovery };
    this._panes = panes;
    return true;
  }

  private _clearAttachmentState(): boolean {
    const changed =
      this._attached !== null ||
      this._panes.length !== 0 ||
      this._activePaneId !== 0 ||
      this._layout !== '' ||
      this._bellPanes.size !== 0 ||
      this._pending.size !== 0;
    if (!changed) return false;

    this._attached = null;
    this._panes = [];
    this._activePaneId = 0;
    this._layout = '';
    this._bellPanes.clear();
    for (const record of this._pending.values()) {
      if (record.timer !== undefined) clearTimeout(record.timer);
    }
    this._pending.clear();
    return true;
  }
}

export const store = new MuxStore();