/**
 * The PROJECT is muxterm's unit of containment, browser side.
 *
 * This file is the mirror of internal/sessiond/project.go. If you change a
 * field or a constant here, change it there in the same commit.
 *
 * Every session belongs to exactly one project, always. There is no null case
 * and no orphan is representable: a session that belongs to no real project
 * belongs to the INBOX, a fixed reserved container that ships with the daemon.
 * "Unassigned" is a CONTAINER, never a STATE.
 *
 * Workspaces are NOT projects and are not demoted by this file. The machine
 * tree, the workspace rows and the panes inside them keep working exactly as
 * they did; the project layer sits alongside them.
 *
 * DEFERRED, deliberately absent: project creation, naming, renaming, deletion,
 * settings, shared context, per-project folders, cross-machine identity.
 */

import type { SessionState } from './session-state.js';

/**
 * A project's identity.
 *
 * A branded string rather than a bare one, mirroring Go's distinct ProjectID
 * type. The brand is what stops a workspace id, a session id or a machine name
 * being passed where a container is meant -- in a codebase where all four are
 * strings, that is a mistake the compiler should be catching, not a code
 * reviewer.
 */
export type ProjectId = string & { readonly __brand: 'ProjectId' };

/**
 * The reserved, fixed id of the Inbox. Identical on every machine and in every
 * installation; never handed out to a user-created project.
 */
export const INBOX_PROJECT_ID = 'inbox' as ProjectId;

/**
 * What the Inbox is called on screen. The container is called "Inbox" -- not
 * "Unfiled", not "Uncategorized", not "No project". Those name an absence;
 * this names a place, and a place is what it is.
 */
export const INBOX_PROJECT_NAME = 'Inbox';

/** One container, as published by the daemon. */
export interface Project {
  id: ProjectId;
  name: string;
  /**
   * The daemon saying this container cannot be renamed or deleted, so the UI
   * can decline to OFFER either rather than offering an action that is going
   * to be refused. True for the Inbox.
   */
  reserved: boolean;
}

/**
 * The container every session falls back to.
 *
 * Used when the daemon has not yet answered `list-projects` -- a browser that
 * has just connected must still be able to render its rows somewhere, and the
 * Inbox's id is a constant, so it can do that without asking.
 */
export const INBOX_PROJECT: Project = {
  id: INBOX_PROJECT_ID,
  name: INBOX_PROJECT_NAME,
  reserved: true,
};

/**
 * Resolve any row to the container it belongs to.
 *
 * TOTAL BY CONSTRUCTION: there is no session -- missing field, empty string, a
 * project that no longer exists, a row from a daemon too old to stamp one --
 * for which this returns nothing. That is the browser-side half of the
 * invariant the Go marshaler enforces on the wire, and the reason no component
 * in this codebase ever writes `session.projectId ?? something`.
 */
export function projectIdOf(session: SessionState, known?: ReadonlySet<string>): ProjectId {
  const raw = session.projectId;
  if (typeof raw !== 'string' || raw === '') return INBOX_PROJECT_ID;
  if (known && !known.has(raw)) return INBOX_PROJECT_ID;
  return raw as ProjectId;
}

/**
 * THE NAMING RULE for a session inside a container.
 *
 * A session with no project still needs a readable name, and after this slice
 * every session is inside a container, so this rule is what every row in the
 * Inbox is titled by. It is a strict fallback ladder, most human first, and it
 * ends in something that is never empty:
 *
 *   1. `label`  -- the producer's own 1-3 word name for the work ("auth
 *      redirect"). Derived once from the first prompt and never changed, which
 *      is the property a list wants: a row whose name moves is a row you
 *      cannot find twice.
 *   2. `name`   -- the session's first prompt, trimmed to its first line. Real
 *      lane names in this system are entire instruction PARAGRAPHS, so this is
 *      cut at the first newline and then bounded; the full text stays on the
 *      row's own card, which is where somebody who wants it will look.
 *   3. the working directory's last segment -- for a session that declared
 *      neither, "muxterm" beats a hex id for recognising your own work.
 *   4. `session <first 8 of the id>` -- the guaranteed floor. Never empty,
 *      never "Untitled", never blank space where a name should be.
 *
 * Deliberately NOT in the ladder: the harness name, the machine, the state.
 * Those are attributes shown elsewhere on the row; a title made of them names
 * a category rather than a piece of work, and every Codex lane would be called
 * "codex".
 */
const SESSION_TITLE_MAX = 72;

export function sessionTitle(session: SessionState): string {
  const label = session.label?.trim();
  if (label) return clampTitle(label);

  const name = session.name?.trim();
  if (name) {
    const firstLine = name.split('\n', 1)[0]?.trim();
    if (firstLine) return clampTitle(firstLine);
  }

  const project = session.project?.trim();
  if (project) {
    const segment = project.replace(/\/+$/, '').split('/').pop()?.trim();
    if (segment) return clampTitle(segment);
  }

  const id = session.sessionId?.trim();
  if (id) return `session ${id.slice(0, 8)}`;
  // Unreachable through the wire contract, which requires sessionId. Present
  // so the function's return type is honest rather than relying on a promise
  // made somewhere else.
  return 'session';
}

/** Cut a title to one readable line, with an ellipsis rather than a hard stop. */
function clampTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SESSION_TITLE_MAX) return collapsed;
  return `${collapsed.slice(0, SESSION_TITLE_MAX - 1).trimEnd()}\u2026`;
}

/**
 * The known containers, and the filing destination list.
 *
 * A wholesale-replacement store on homeSessions' model: the daemon is
 * authoritative and there is no merge. It starts holding the Inbox rather than
 * holding nothing, because the Inbox's id is a constant and a browser that has
 * not yet heard back must still have somewhere to put its rows.
 */
class ProjectStore {
  private _projects: readonly Project[] = [INBOX_PROJECT];
  private _listeners = new Set<() => void>();

  get projects(): readonly Project[] {
    return this._projects;
  }

  /** Ids that currently exist, for resolving a row's container. */
  get knownIds(): ReadonlySet<string> {
    return new Set(this._projects.map((p) => p.id));
  }

  /**
   * The list a filing gesture offers.
   *
   * It is simply every project. Today that is exactly one entry, the Inbox,
   * and NOTHING IN THE UI KNOWS THAT -- the menu renders whatever this
   * returns. The day a second project exists it appears here with no browser
   * change at all, which is the migration claim this slice is making, written
   * as code rather than as a promise.
   */
  get destinations(): readonly Project[] {
    return this._projects;
  }

  get(id: string): Project | undefined {
    return this._projects.find((p) => p.id === id);
  }

  /** Name for display, falling back to the id so a row is never blank. */
  nameOf(id: string): string {
    return this.get(id)?.name ?? id;
  }

  /**
   * Replace the whole set from a `project-list` reply.
   *
   * An empty or malformed payload keeps the Inbox rather than emptying the
   * store. There is no state of the world in which zero containers is the
   * truth -- the daemon constructs the Inbox in memory and cannot fail to have
   * one -- so an empty list is evidence of a bad frame, not of an empty
   * installation, and dropping every row's home over it would be the worst
   * possible reading.
   */
  set(projects: readonly Project[] | null | undefined): void {
    const next = (projects ?? []).filter((p) => typeof p?.id === 'string' && p.id !== '');
    this._projects = next.length > 0 ? next : [INBOX_PROJECT];
    this._notify();
  }

  subscribe(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  private _notify(): void {
    for (const cb of this._listeners) cb();
  }
}

export const projectStore = new ProjectStore();

/**
 * Group rows by container, in the store's order, INCLUDING CONTAINERS WITH NO
 * ROWS.
 *
 * Empty groups are kept on purpose. A container that vanishes when it empties
 * and reappears when it fills is a container you cannot file INTO, and the
 * Inbox going missing the moment it is empty would read as breakage every
 * time somebody cleared their fleet. See the sidebar's empty state.
 */
export function groupSessionsByProject(
  sessions: readonly SessionState[],
  projects: readonly Project[],
): { project: Project; sessions: SessionState[] }[] {
  const known = new Set(projects.map((p) => p.id));
  const buckets = new Map<string, SessionState[]>();
  for (const project of projects) buckets.set(project.id, []);
  for (const session of sessions) {
    const id = projectIdOf(session, known);
    // projectIdOf already resolved an unknown id to the Inbox, so this bucket
    // always exists -- but if the Inbox itself were somehow absent from the
    // list, dropping the row silently would be worse than showing it.
    const bucket = buckets.get(id) ?? buckets.get(INBOX_PROJECT_ID);
    bucket?.push(session);
  }
  return projects.map((project) => ({
    project,
    sessions: buckets.get(project.id) ?? [],
  }));
}
