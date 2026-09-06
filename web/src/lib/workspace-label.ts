import type { SessiondWorkspaceInfo } from '../types.js';
import { parseHostRef } from './host-ref.js';

/**
 * Human-readable label for a workspace: prefer the explicit name, otherwise
 * fall back to a stable id-based label.
 *
 * Lived in `components/workspace-picker.ts` until that component was deleted
 * (D3 of docs/designs/2026-09-05-mobile-navigation-design.md). It was the only
 * part of that file with real consumers, so it moved here rather than dying
 * with it.
 *
 * The label is derived from the DAEMON-LOCAL id, never the namespaced one: the
 * digit squeeze below is a squeeze over the whole string, so `ssh:box2/w1`
 * would otherwise render "workspace 21" — a number no daemon ever issued, and
 * one that changes the moment a host is renamed. Stripping the qualifier first
 * makes the label say what the owning daemon calls the workspace, which is the
 * only stable answer available here.
 *
 * It deliberately does NOT name the machine. A label is not a location: the
 * sidebar's host group header (ux D1) and the dock's `.hostpin` (ux D5) already
 * say which machine you are looking at, and repeating it in every card would
 * say it twice on the surfaces that have it and still be wrong on the ones
 * that do not. Two machines can therefore both show "workspace 1"; the group
 * they sit in is what distinguishes them.
 *
 * `parseHostRef('w1').localId === 'w1'` (rule P2), so a browser with no remotes
 * gets byte-identical output to what it got before this existed.
 */
export function workspaceLabel(ws: SessiondWorkspaceInfo): string {
  if (ws.name && ws.name.length > 0) return ws.name;
  const localId = parseHostRef(ws.workspaceId).localId;
  const n = localId.replace(/\D/g, '');
  // The last fallback is the id AS GIVEN. It can only be reached by a host
  // selector ("ssh:boxb/", rule P6), which is not a workspace and must never
  // reach this function — and if one ever does, a visibly wrong label beats a
  // blank one. For a local id localId IS ws.workspaceId, so this changes
  // nothing on a browser with no remotes.
  return `workspace ${n || localId || ws.workspaceId}`;
}
