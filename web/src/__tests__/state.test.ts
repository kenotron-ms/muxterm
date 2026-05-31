import { describe, it, expect, vi } from 'vitest';
import { createInitialState, MuxStore } from '../state';
import type { ServerMessage, TmuxState } from '../types';
import { DEFAULT_RESOLVED_CONFIG, parseResolvedConfig } from '../lib/config';

describe('MuxStore', () => {
  it('starts with empty initial state', () => {
    const store = new MuxStore();
    const state = store.state;
    expect(state).toEqual(createInitialState());
    expect(state.sessions).toEqual([]);
    expect(state.activeSession).toBe('');
    expect(state.activeWindow).toBe(0);
    expect(state.activePane).toBe(0);
  });

  it('applies full state sync via state message', () => {
    const store = new MuxStore();
    const fullState: TmuxState = {
      sessions: [
        {
          name: 'main',
          windows: [
            { id: 1, name: 'shell', panes: [], layout: '' },
          ],
        },
      ],
      activeSession: 'main',
      activeWindow: 1,
      activePane: 0,
    };
    const msg: ServerMessage = { type: 'state', data: fullState };
    store.applyMessage(msg);
    expect(store.state).toEqual(fullState);
  });

  it('notifies subscribers on state change', () => {
    const store = new MuxStore();
    const listener = vi.fn();
    store.subscribe(listener);

    const msg: ServerMessage = {
      type: 'state',
      data: {
        sessions: [],
        activeSession: 'test',
        activeWindow: 0,
        activePane: 0,
      },
    };
    store.applyMessage(msg);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const store = new MuxStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    const msg: ServerMessage = {
      type: 'state',
      data: createInitialState(),
    };
    store.applyMessage(msg);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    store.applyMessage(msg);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('applies window-add to active session', () => {
    const store = new MuxStore();
    // Set up a state with an active session
    store.applyMessage({
      type: 'state',
      data: {
        sessions: [{ name: 'main', windows: [] }],
        activeSession: 'main',
        activeWindow: 0,
        activePane: 0,
      },
    });

    store.applyMessage({
      type: 'window-add',
      data: { id: 1, name: 'vim', panes: [], layout: '' },
    });

    expect(store.state.sessions[0].windows).toHaveLength(1);
    expect(store.state.sessions[0].windows[0]).toEqual({
      id: 1,
      name: 'vim',
      panes: [],
      layout: '',
    });
  });

  it('applies window-renamed', () => {
    const store = new MuxStore();
    store.applyMessage({
      type: 'state',
      data: {
        sessions: [
          {
            name: 'main',
            windows: [{ id: 1, name: 'old-name', panes: [], layout: '' }],
          },
        ],
        activeSession: 'main',
        activeWindow: 1,
        activePane: 0,
      },
    });

    store.applyMessage({
      type: 'window-renamed',
      data: { id: 1, name: 'new-name' },
    });

    expect(store.state.sessions[0].windows[0].name).toBe('new-name');
  });

  it('applies layout-change', () => {
    const store = new MuxStore();
    store.applyMessage({
      type: 'state',
      data: {
        sessions: [
          {
            name: 'main',
            windows: [{ id: 1, name: 'shell', panes: [], layout: '' }],
          },
        ],
        activeSession: 'main',
        activeWindow: 1,
        activePane: 0,
      },
    });

    store.applyMessage({
      type: 'layout-change',
      data: { windowId: 1, layout: '1234,80x24,0,0,1' },
    });

    expect(store.state.sessions[0].windows[0].layout).toBe('1234,80x24,0,0,1');
  });

  it('applies session-window-changed', () => {
    const store = new MuxStore();
    store.applyMessage({
      type: 'state',
      data: createInitialState(),
    });

    store.applyMessage({
      type: 'session-window-changed',
      data: { windowId: 5 },
    });

    expect(store.state.activeWindow).toBe(5);
  });

  it('applies window-close', () => {
    const store = new MuxStore();
    store.applyMessage({
      type: 'state',
      data: {
        sessions: [
          {
            name: 'main',
            windows: [
              { id: 1, name: 'keep', panes: [], layout: '' },
              { id: 2, name: 'remove', panes: [], layout: '' },
            ],
          },
        ],
        activeSession: 'main',
        activeWindow: 1,
        activePane: 0,
      },
    });

    store.applyMessage({
      type: 'window-close',
      data: { id: 2 },
    });

    expect(store.state.sessions[0].windows).toHaveLength(1);
    expect(store.state.sessions[0].windows[0].name).toBe('keep');
  });

  describe('config', () => {
    it('store.config equals DEFAULT_RESOLVED_CONFIG before any config frame', () => {
      const store = new MuxStore();
      expect(store.config).toEqual(DEFAULT_RESOLVED_CONFIG);
    });

    it('setConfig updates config and notifies listeners', () => {
      const store = new MuxStore();
      const listener = vi.fn();
      store.subscribe(listener);

      const cfg = parseResolvedConfig({ theme: { palette: 'gruvbox' } });
      store.setConfig(cfg);

      expect(store.config.theme.palette).toBe('gruvbox');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});