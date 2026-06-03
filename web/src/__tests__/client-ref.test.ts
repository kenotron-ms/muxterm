import { describe, it, expect } from 'vitest';
import { mintClientRef } from '../lib/client-ref';

describe('mintClientRef', () => {
  it('returns a non-empty string with tmp- prefix and length > 4', () => {
    const ref = mintClientRef();
    expect(typeof ref).toBe('string');
    expect(ref.length).toBeGreaterThan(4);
    expect(ref.startsWith('tmp-')).toBe(true);
  });

  it('yields unique values across 100 calls', () => {
    const refs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      refs.add(mintClientRef());
    }
    expect(refs.size).toBe(100);
  });
});
