import { describe, it, expect, vi, beforeEach } from 'vitest';
import { browserRegistry } from './browser-registry.js';
import type { BrowserPaneCallbacks } from './browser-registry.js';

beforeEach(() => {
  // Prune all known panes between tests by pruning with empty set
  // We need to reset state — use prune with empty set
  // However, prune only removes known panes so we track ids.
  // We'll just use fresh pane IDs per test or rely on module reset via vi.resetModules
  // Since we can't easily reset the module singleton, we'll use unique pane IDs per test.
});

describe('browserRegistry', () => {
  describe('ensure()', () => {
    it('creates a callback slot for a new pane ID', () => {
      const paneId = 1001;
      expect(browserRegistry.has(paneId)).toBe(false);
      browserRegistry.ensure(paneId);
      expect(browserRegistry.has(paneId)).toBe(true);
    });

    it('is idempotent — calling twice does not throw or duplicate', () => {
      const paneId = 1002;
      browserRegistry.ensure(paneId);
      expect(() => browserRegistry.ensure(paneId)).not.toThrow();
      expect(browserRegistry.has(paneId)).toBe(true);
    });
  });

  describe('has()', () => {
    it('returns false for unknown pane ID', () => {
      expect(browserRegistry.has(99999)).toBe(false);
    });

    it('returns true after ensure()', () => {
      const paneId = 1003;
      browserRegistry.ensure(paneId);
      expect(browserRegistry.has(paneId)).toBe(true);
    });
  });

  describe('setCallbacks()', () => {
    it('registers onFrame callback and write() calls it', () => {
      const paneId = 1004;
      browserRegistry.ensure(paneId);

      const onFrame = vi.fn();
      browserRegistry.setCallbacks(paneId, { onFrame });

      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      browserRegistry.write(paneId, jpeg);

      expect(onFrame).toHaveBeenCalledOnce();
      expect(onFrame).toHaveBeenCalledWith(jpeg);
    });

    it('registers onUrl callback and dispatchUrl() calls it', () => {
      const paneId = 1005;
      browserRegistry.ensure(paneId);

      const onUrl = vi.fn();
      browserRegistry.setCallbacks(paneId, { onUrl });

      browserRegistry.dispatchUrl(paneId, 'https://example.com');

      expect(onUrl).toHaveBeenCalledOnce();
      expect(onUrl).toHaveBeenCalledWith('https://example.com');
    });

    it('registers onError callback and dispatchError() calls it', () => {
      const paneId = 1006;
      browserRegistry.ensure(paneId);

      const onError = vi.fn();
      browserRegistry.setCallbacks(paneId, { onError });

      browserRegistry.dispatchError(paneId, 'net::ERR_NAME_NOT_RESOLVED');

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith('net::ERR_NAME_NOT_RESOLVED');
    });

    it('registers onDownload callback and dispatchDownload() calls it', () => {
      const paneId = 1007;
      browserRegistry.ensure(paneId);

      const onDownload = vi.fn();
      browserRegistry.setCallbacks(paneId, { onDownload });

      browserRegistry.dispatchDownload(paneId, 42);

      expect(onDownload).toHaveBeenCalledOnce();
      expect(onDownload).toHaveBeenCalledWith(42);
    });

    it('registers onStatus callback and dispatchStatus() calls it', () => {
      const paneId = 1008;
      browserRegistry.ensure(paneId);

      const onStatus = vi.fn();
      browserRegistry.setCallbacks(paneId, { onStatus });

      browserRegistry.dispatchStatus(paneId, 'Loading...');

      expect(onStatus).toHaveBeenCalledOnce();
      expect(onStatus).toHaveBeenCalledWith('Loading...');
    });

    it('supports partial callbacks — only registered callbacks are called', () => {
      const paneId = 1009;
      browserRegistry.ensure(paneId);

      const onUrl = vi.fn();
      browserRegistry.setCallbacks(paneId, { onUrl });

      // write() with no onFrame registered — should not throw
      expect(() =>
        browserRegistry.write(paneId, new Uint8Array([0xff]))
      ).not.toThrow();

      // dispatchUrl still calls onUrl
      browserRegistry.dispatchUrl(paneId, 'https://test.com');
      expect(onUrl).toHaveBeenCalledOnce();
    });

    it('overwrites callbacks when called again', () => {
      const paneId = 1010;
      browserRegistry.ensure(paneId);

      const first = vi.fn();
      const second = vi.fn();

      browserRegistry.setCallbacks(paneId, { onUrl: first });
      browserRegistry.setCallbacks(paneId, { onUrl: second });

      browserRegistry.dispatchUrl(paneId, 'https://test.com');

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });

    it('clears callback when null is passed', () => {
      const paneId = 1011;
      browserRegistry.ensure(paneId);

      const onFrame = vi.fn();
      browserRegistry.setCallbacks(paneId, { onFrame });
      // Clear the callback
      browserRegistry.setCallbacks(paneId, { onFrame: null });

      // Should not throw and not call the cleared callback
      expect(() =>
        browserRegistry.write(paneId, new Uint8Array([0xff]))
      ).not.toThrow();
      expect(onFrame).not.toHaveBeenCalled();
    });
  });

  describe('dispatch methods with no registered callback', () => {
    it('write() is a no-op for unknown pane', () => {
      expect(() =>
        browserRegistry.write(99998, new Uint8Array([0xff]))
      ).not.toThrow();
    });

    it('dispatchUrl() is a no-op for unknown pane', () => {
      expect(() =>
        browserRegistry.dispatchUrl(99997, 'https://x.com')
      ).not.toThrow();
    });

    it('dispatchError() is a no-op for unknown pane', () => {
      expect(() =>
        browserRegistry.dispatchError(99996, 'err')
      ).not.toThrow();
    });

    it('dispatchDownload() is a no-op for unknown pane', () => {
      expect(() =>
        browserRegistry.dispatchDownload(99995, 50)
      ).not.toThrow();
    });

    it('dispatchStatus() is a no-op for unknown pane', () => {
      expect(() =>
        browserRegistry.dispatchStatus(99994, 'ok')
      ).not.toThrow();
    });
  });

  describe('prune()', () => {
    it('removes entries not in liveIds', () => {
      const paneId = 2001;
      browserRegistry.ensure(paneId);
      expect(browserRegistry.has(paneId)).toBe(true);

      browserRegistry.prune(new Set([9999])); // 2001 not in live set
      expect(browserRegistry.has(paneId)).toBe(false);
    });

    it('keeps entries that are in liveIds', () => {
      const paneId = 2002;
      browserRegistry.ensure(paneId);

      browserRegistry.prune(new Set([paneId]));
      expect(browserRegistry.has(paneId)).toBe(true);
    });

    it('clears callbacks before deleting — in-flight dispatch is a no-op', () => {
      const paneId = 2003;
      browserRegistry.ensure(paneId);

      const onFrame = vi.fn();
      browserRegistry.setCallbacks(paneId, { onFrame });

      // Prune removes the pane
      browserRegistry.prune(new Set());

      // Any dispatch after prune should be a no-op
      browserRegistry.write(paneId, new Uint8Array([0xff]));
      expect(onFrame).not.toHaveBeenCalled();
    });

    it('handles empty liveIds — removes all entries', () => {
      const paneA = 2004;
      const paneB = 2005;
      browserRegistry.ensure(paneA);
      browserRegistry.ensure(paneB);

      browserRegistry.prune(new Set());

      expect(browserRegistry.has(paneA)).toBe(false);
      expect(browserRegistry.has(paneB)).toBe(false);
    });
  });

  describe('type safety', () => {
    it('BrowserPaneCallbacks fields accept null', () => {
      const paneId = 3001;
      browserRegistry.ensure(paneId);

      // All fields nullable
      const cbs: Partial<BrowserPaneCallbacks> = {
        onFrame: null,
        onUrl: null,
        onError: null,
        onDownload: null,
        onStatus: null,
      };

      expect(() => browserRegistry.setCallbacks(paneId, cbs)).not.toThrow();
    });
  });
});
