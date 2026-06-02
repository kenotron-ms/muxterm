// Thin coordination seam between frozen SessiondMessage events / UI intents and
// socket actions + arrangement decisions.
//
// This controller owns NO wire state of its own beyond client-local bookkeeping
// (MRU order, in-flight recovery target). It reads composition/attachment truth
// from the MuxStore and turns the frozen sessiond message vocabulary into the
// next socket action. Keyed entirely off the frozen message/error-code
// constants -- never hardcoded strings -- so it speaks the same vocabulary as
// sessiond.

import type { MuxStore } from '../state.js';
import { SessiondType, SessiondErrorCode, type SessiondMessage } from '../types';
import { arrange, viewportClassFor, type Arrangement } from './layout.js';
import { ArrangementStore } from './arrangement-store.js';
import { WorkspaceMru } from './workspace-mru.js';
import { chooseRecoveryTarget } from './workspace-recovery.js';

const LAST_WS_KEY = 'muxterm.lastWorkspaceId';

/**
 * Test-mockable subset of MuxSocket the controller drives. Keeping this narrow
 * lets tests inject a fakeSocket of plain spies without the full socket.
 */
export interface WorkspaceSocket {
  attach(workspaceId: string): void;
  createWorkspace(name?: string): void;
  listWorkspaces(): void;
  resize(paneId: number, cols: number, rows: number): void;
}

export class WorkspaceController {
  private _mru = new WorkspaceMru();
  private _arrangements = new ArrangementStore();
  // null = not recovering; '' = bootstrap default (attach first listed);
  // otherwise the id of the workspace we are recovering away from.
  private _recoveringFrom: string | null = null;

  constructor(
    private store: MuxStore,
    private socket: WorkspaceSocket,
  ) {}

  /** On connect: attach the last workspace if known, else list + attach first. */
  bootstrap(): void {
    const stored = localStorage.getItem(LAST_WS_KEY);
    if (stored !== null) {
      this.socket.attach(stored);
      return;
    }
    this._recoveringFrom = '';
    this.socket.listWorkspaces();
  }

  /** Turn a frozen sessiond message into the next socket action. */
  onMessage(msg: SessiondMessage): void {
    switch (msg.type) {
      // attach reply: binds us to a workspace -> record MRU + persist last.
      case SessiondType.Composition: {
        const id = msg.workspaceId ?? '';
        this._mru.touch(id);
        localStorage.setItem(LAST_WS_KEY, id);
        break;
      }

      case SessiondType.WorkspaceClosed: {
        const id = msg.workspaceId ?? '';
        this._mru.forget(id);
        // Only recover when WE lost our active workspace (store already detached
        // to null) or the closed one is still our attachment.
        if (this.store.attached === id || this.store.attached === null) {
          this._recoveringFrom = id;
          this.socket.listWorkspaces();
        }
        break;
      }

      case SessiondType.Error: {
        if (msg.code === SessiondErrorCode.UnknownWorkspace) {
          const stale = msg.workspaceId ?? '';
          if (localStorage.getItem(LAST_WS_KEY) === stale) {
            localStorage.removeItem(LAST_WS_KEY);
          }
          this._recoveringFrom = stale;
          this.socket.listWorkspaces();
        }
        // Non-recovery errors (e.g. pane-spawn-failed) are ignored here.
        break;
      }

      case SessiondType.WorkspaceList: {
        if (this._recoveringFrom !== null) {
          const target = chooseRecoveryTarget(
            msg.workspaces ?? [],
            this._recoveringFrom,
            this._mru.order(),
          );
          this._recoveringFrom = null;
          if (target.action === 'attach') {
            this.socket.attach(target.workspaceId);
          } else {
            this.socket.createWorkspace();
          }
        }
        break;
      }

      // no-survivor recovery path: attach the freshly-created workspace.
      case SessiondType.WorkspaceCreated: {
        this.socket.attach(msg.workspaceId ?? '');
        break;
      }

      default:
        break;
    }
  }

  /** Active-view-wins: forward a pane resize for the focused composition. */
  reportResize(paneId: number, cols: number, rows: number): void {
    this.socket.resize(paneId, cols, rows);
  }

  /** Select the arrangement for the attached workspace at this viewport width. */
  currentArrangement(viewportWidthPx: number): Arrangement {
    const profile = viewportClassFor(viewportWidthPx);
    const wsId = this.store.attached;
    if (!wsId) {
      return arrange(this.store.composition, profile);
    }
    return this._arrangements.load(wsId, profile, this.store.composition);
  }
}
