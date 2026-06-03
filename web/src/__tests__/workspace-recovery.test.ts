import { describe, it, expect } from 'vitest';
import { chooseRecoveryTarget } from '../lib/workspace-recovery';
import type { SessiondWorkspaceInfo } from '../types';

function ws(id: string): SessiondWorkspaceInfo {
  return { workspaceId: id, paneCount: 0 };
}

describe('chooseRecoveryTarget', () => {
  it('prefers the most-recently-active surviving workspace', () => {
    const survivors = [ws('a'), ws('b'), ws('c')];
    const mru = ['b', 'a', 'c'];
    expect(chooseRecoveryTarget(survivors, 'closed', mru)).toEqual({
      action: 'attach',
      workspaceId: 'b',
    });
  });

  it('skips the closed workspace even if it tops MRU', () => {
    const survivors = [ws('a'), ws('b')];
    const mru = ['closed', 'a', 'b'];
    expect(chooseRecoveryTarget(survivors, 'closed', mru)).toEqual({
      action: 'attach',
      workspaceId: 'a',
    });
  });

  it('falls back to first survivor when MRU has no live match', () => {
    const survivors = [ws('a'), ws('b')];
    const mru = ['x', 'y', 'z'];
    expect(chooseRecoveryTarget(survivors, 'closed', mru)).toEqual({
      action: 'attach',
      workspaceId: 'a',
    });
  });

  it("requests fresh 'create' when none survive", () => {
    expect(chooseRecoveryTarget([], 'closed', ['closed'])).toEqual({
      action: 'create',
    });
  });

  it('never returns the closed workspace even if a stale list still contains it', () => {
    const survivors = [ws('closed'), ws('a')];
    const mru = ['closed', 'a'];
    expect(chooseRecoveryTarget(survivors, 'closed', mru)).toEqual({
      action: 'attach',
      workspaceId: 'a',
    });
  });
});
