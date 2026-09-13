/**
 * On-demand workspace-screen previews.
 *
 * Workspace rows are intentionally cheap at rest. The store keeps only the
 * presentation mode and the authenticated socket; a hover/focus intent asks
 * sessiond for one authoritative full VT viewport and owns no polling loop.
 */

import { tileFromScreen } from './preview-tile.js';
import type { PreviewTile } from './preview-tile.js';
import type { SessiondMessage } from '../types.js';
import type { MuxSocket } from '../ws.js';

export interface PreviewEntry {
  paneId: number;
  title: string;
  live: boolean;
  tile: PreviewTile;
}

export type PreviewMode = 'full' | 'compact' | 'off';

function normalizeMode(mode: string): PreviewMode {
  return mode === 'off' ? 'off' : mode === 'compact' ? 'compact' : 'full';
}

class PreviewStore {
  private _socket: MuxSocket | null = null;
  private _mode: PreviewMode = 'off';

  attach(socket: MuxSocket): void {
    this._socket = socket;
  }

  setMode(mode: PreviewMode): void {
    this._mode = normalizeMode(mode);
  }

  get mode(): PreviewMode {
    return this._mode;
  }

  /** Legacy card-sizing API; on-demand previews do not reserve row tiles. */
  get rows(): number {
    return 0;
  }

  /** Retained as a compatibility no-op for older callers. */
  resubscribe(): void {}

  /** Retained as a compatibility no-op; new UI never subscribes to screen pushes. */
  handleWorkspacePreview(_msg: SessiondMessage): void {}

  async request(workspaceId: string, signal?: AbortSignal): Promise<PreviewEntry | null> {
    if (this._mode === 'off' || !this._socket) return null;
    const result = await this._socket.requestWorkspaceScreen(workspaceId, signal);
    return {
      paneId: result.paneId,
      title: '',
      live: true,
      tile: tileFromScreen(result.lines, result.fg, result.bg, result.inverse, result.cols, result.rows),
    };
  }

  /** Retained for compatibility with the previous card implementation. */
  get(_workspaceId: string, _cols: number, _rows: number): PreviewEntry | null {
    return null;
  }

  /** Retained for compatibility; it never starts work. */
  subscribe(_fn: () => void): () => void {
    return () => {};
  }
}

export const previewStore = new PreviewStore();