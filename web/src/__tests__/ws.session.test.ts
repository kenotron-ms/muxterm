import { describe, it, expect } from 'vitest';
import { encodeClientMessage, normalizeMessage } from '../ws';

describe('encodeClientMessage – attach-session', () => {
  it('encodes attach-session with the session name as value', () => {
    const result = encodeClientMessage({ type: 'attach-session', name: 'ops' });
    expect(result).toEqual({ 'attach-session': 'ops' });
  });
});

describe('normalizeMessage – session-list', () => {
  it('normalizes session-list payload into typed message with sessions array', () => {
    const raw = {
      'session-list': {
        sessions: [
          { name: 'dev', windows: 2 },
          { name: 'ops', windows: 1 },
        ],
      },
    };
    const result = normalizeMessage(raw);
    expect(result).toEqual({
      type: 'session-list',
      data: {
        sessions: [
          { name: 'dev', windows: 2 },
          { name: 'ops', windows: 1 },
        ],
      },
    });
  });
});
