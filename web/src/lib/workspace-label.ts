import type { SessiondWorkspaceInfo } from '../types.js';

/**
 * Human-readable label for a workspace: prefer the explicit name, otherwise
 * fall back to a stable id-based label.
 *
 * Lived in `components/workspace-picker.ts` until that component was deleted
 * (D3 of docs/designs/2026-09-05-mobile-navigation-design.md). It was the only
 * part of that file with real consumers, so it moved here rather than dying
 * with it.
 */
export function workspaceLabel(ws: SessiondWorkspaceInfo): string {
  if (ws.name && ws.name.length > 0) return ws.name;
  const n = ws.workspaceId.replace(/\D/g, '');
  return `workspace ${n || ws.workspaceId}`;
}
