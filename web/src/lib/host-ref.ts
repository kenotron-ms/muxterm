/**
 * host-ref.ts — namespaced workspace identifiers, browser side.
 *
 * One qualifier, one separator, six rules:
 *
 *     <HostRef.ID> "/" <daemon-local id>   remote,  e.g. "ssh:boxb/w1"
 *     <daemon-local id>                    local,   e.g. "w1"
 *     <HostRef.ID> "/"                     host selector (create-workspace only)
 *
 * The qualifier is always the host's ID, never its display name: display names
 * are mutable labels, and a workspace reference that breaks when someone
 * relabels a host is a bug that only shows up in production.
 *
 * These rules mirror `internal/server/hostid.go` byte for byte — same first-
 * separator split, same untouched local id. Change one side and you must
 * change the other, because the server stamps ids with nsID() and this module
 * is the only thing that reads them back apart.
 *
 * Namespacing exists ONLY at the browser edge, because only the browser sees
 * more than one daemon at once. No daemon and no CLI ever sees a prefixed id.
 */

/**
 * hostSep separates the host qualifier from the daemon-local id. A single byte
 * on purpose: parseHostRef has to be cheap and unambiguous, and the admission
 * rule that a host id must not contain "/" (enforced server-side in
 * `validHostID`) is what buys the second property.
 */
const hostSep = '/';

/** The two halves of a namespaced id. `host` is '' for the local daemon. */
export interface HostRefParts {
  /** The host qualifier, or '' for the local daemon. Never contains '/'. */
  host: string;
  /** The daemon-local id, exactly as that daemon issued it. */
  localId: string;
}

/**
 * Parse a namespaced id (rule P2): the FIRST separator wins, and an id
 * carrying no separator is local → { host: '', localId: id }.
 *
 * That the host qualifier cannot itself contain "/" (rule P3) is what makes
 * this total and unambiguous, and therefore what makes the round trip hold:
 * parseHostRef(formatHostRef(h, l)) === { host: h, localId: l } for every
 * admissible h and every l (rule P4).
 *
 * An empty local part is the host selector (rule P6) — legal only on
 * create-workspace. This function reports it faithfully and leaves that
 * judgement to the caller, which is the only place that knows the message
 * type.
 */
export function parseHostRef(id: string): HostRefParts {
  const i = id.indexOf(hostSep);
  if (i < 0) return { host: '', localId: id };
  return { host: id.slice(0, i), localId: id.slice(i + 1) };
}

/**
 * Format a namespaced id (rule P1).
 *
 * The empty host is the local daemon and returns localId UNCHANGED (rule P5).
 * That is not an optimization, it is the zero-remote guarantee stated as an
 * algebraic law: `formatHostRef('', l) === l`. A browser with no remotes
 * configured sees exactly the ids it sees today, because every stamp site on
 * both sides of the wire is this function or its Go twin.
 */
export function formatHostRef(host: string, localId: string): string {
  if (host === '') return localId;
  return host + hostSep + localId;
}

/**
 * True when this id names a workspace on a remote host.
 *
 * Local ids stay bare, so this is exactly "does it carry a qualifier". Use it
 * to decide whether an id needs host treatment at all; use parseHostRef when
 * you need the parts.
 */
export function isRemoteId(id: string): boolean {
  return parseHostRef(id).host !== '';
}

/**
 * The host selector for `host` (rule P6): a namespaced id with an EMPTY local
 * part, e.g. "ssh:boxb/". It is how a per-group "+ New workspace" names the
 * host it wants the workspace created on, and it is legal on create-workspace
 * and nowhere else — anywhere else it is a client error.
 *
 * Defined as formatHostRef(host, '') rather than as a separate template so P5
 * covers it for free: the LOCAL selector is the empty string, not "/". A
 * caller creating a local workspace therefore sends no workspaceId at all,
 * which is byte-identical to today's message.
 */
export function hostSelector(host: string): string {
  return formatHostRef(host, '');
}
