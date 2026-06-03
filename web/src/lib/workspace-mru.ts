/**
 * Client-local most-recently-active workspace tracker.
 *
 * Records the order in which workspaces were attached/switched to, so
 * chooseRecoveryTarget can attach to the most recently used surviving
 * workspace when the active one is closed.
 */
export class WorkspaceMru {
  private _order: string[] = [];

  /** Mark a workspace as most-recently-active. Call on attach/switch. */
  touch(id: string): void {
    this._order = [id, ...this._order.filter((x) => x !== id)];
  }

  /** Remove a workspace from the order. Call on workspace-closed. */
  forget(id: string): void {
    this._order = this._order.filter((x) => x !== id);
  }

  /** Return a copy of the order, most-recently-active first. */
  order(): string[] {
    return [...this._order];
  }
}
