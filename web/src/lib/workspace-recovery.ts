import type { SessiondWorkspaceInfo } from '../types';

export type RecoveryTarget =
  | { action: 'attach'; workspaceId: string }
  | { action: 'create' };

/**
 * Decide which surviving workspace to attach to after a workspace-closed /
 * unknown-workspace event, or whether to create a fresh default.
 *
 * Per design "Workspace lifecycle": detach and attach to the most-recently-
 * active surviving workspace; if none survive, create a fresh default. The
 * closed workspace is never returned as the attach target.
 */
export function chooseRecoveryTarget(
  survivors: SessiondWorkspaceInfo[],
  closedId: string,
  mruOrder: string[],
): RecoveryTarget {
  const liveIds = new Set(survivors.map((w) => w.workspaceId));
  liveIds.delete(closedId);

  // (1) First MRU id that is still live.
  for (const id of mruOrder) {
    if (liveIds.has(id)) {
      return { action: 'attach', workspaceId: id };
    }
  }

  // (2) First survivor that isn't the closed workspace.
  for (const w of survivors) {
    if (w.workspaceId !== closedId) {
      return { action: 'attach', workspaceId: w.workspaceId };
    }
  }

  // (3) Nothing survives -> create a fresh default.
  return { action: 'create' };
}
