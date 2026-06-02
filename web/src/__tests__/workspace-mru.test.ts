import { describe, it, expect } from 'vitest';
import { WorkspaceMru } from '../lib/workspace-mru';

describe('WorkspaceMru', () => {
  it('lists the most-recently-touched workspace first', () => {
    const mru = new WorkspaceMru();
    mru.touch('a');
    mru.touch('b');
    mru.touch('c');
    expect(mru.order()).toEqual(['c', 'b', 'a']);
  });

  it('moves a re-touched id to the front without duplicating', () => {
    const mru = new WorkspaceMru();
    mru.touch('b');
    mru.touch('a');
    mru.touch('b');
    expect(mru.order()).toEqual(['b', 'a']);
  });

  it('forget() removes a closed workspace', () => {
    const mru = new WorkspaceMru();
    mru.touch('a');
    mru.touch('b');
    mru.touch('c');
    mru.forget('b');
    expect(mru.order()).toEqual(['c', 'a']);
  });

  it('starts empty', () => {
    const mru = new WorkspaceMru();
    expect(mru.order()).toEqual([]);
  });
});
