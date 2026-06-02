import { describe, it, expect, vi } from 'vitest';
import { MuxStore } from '../state';
import { DEFAULT_RESOLVED_CONFIG, parseResolvedConfig } from '../lib/config';

describe('MuxStore', () => {
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
