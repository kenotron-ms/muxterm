// Mints session-unique optimistic-create correlation ids.
//
// Uniqueness only needs to hold within a single browser session, so a
// monotonic counter combined with a random base36 suffix is sufficient and
// dependency-free. The daemon echoes the ref back on the authoritative message
// (workspace-list / pane-added) so a pending mutation can settle by exact
// identity rather than fragile counting.

let _counter = 0;

export function mintClientRef(): string {
  _counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `tmp-${_counter}-${rand}`;
}
