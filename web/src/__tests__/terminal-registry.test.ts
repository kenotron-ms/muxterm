import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// terminal-registry is a module-level singleton — import it directly.
// @xterm/xterm is aliased to setup.ts mock (see vite.config.ts),
// so Terminal here is the mock class with getWrittenData() / simulateInput() etc.
import { terminalRegistry, buildTerminalConfig, configureTerminals } from '../lib/terminal-registry.js';
import type { PaneHandlers } from '../lib/terminal-registry.js';
import { DEFAULT_RESOLVED_CONFIG } from '../lib/config.js';
import { resolvePalette } from '../lib/theme.js';

// Helper: a no-op handler set
function handlers(): PaneHandlers {
  return { onInput: vi.fn(), onResize: vi.fn() };
}

// Helper: a container div attached to the document body (needed for attach)
function makeContainer(): HTMLElement {
  const div = document.createElement('div');
  document.body.appendChild(div);
  return div;
}

/**
 * Stub the geometry on the hostEl (container's first child) so that
 * _settleAndDrain's visibility + size guards pass, then invoke the drain.
 *
 * Under the new model, the initial replay is not flushed in attach() itself —
 * it only drains once _settleAndDrain() sees a real, settled size.  In the
 * happy-dom test environment offsetParent/offsetWidth/offsetHeight are always
 * 0/null, so we provide them here to satisfy the guards.
 */
function settleEntry(paneId: number, container: HTMLElement): void {
  // hostEl is appended to container by attach(); get it via firstElementChild.
  const hostEl = container.firstElementChild as HTMLElement;
  if (hostEl) {
    Object.defineProperty(hostEl, 'offsetParent', { value: document.body, configurable: true });
    Object.defineProperty(hostEl, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(hostEl, 'offsetHeight', { value: 600, configurable: true });
  }
  terminalRegistry._settleAndDrain(paneId);
}

describe('terminalRegistry', () => {
  // Clean up ALL registry state between tests so the singleton doesn't leak.
  afterEach(() => {
    terminalRegistry.prune(new Set());
  });

  // ──────────────────────────────────────────────────────────
  // ensure — idempotent creation
  // ──────────────────────────────────────────────────────────
  describe('ensure', () => {
    it('creates a terminal for a new paneId', () => {
      terminalRegistry.ensure(1, handlers());
      expect(terminalRegistry.getTerminal(1)).toBeTruthy();
    });

    it('is idempotent — calling ensure twice returns same terminal', () => {
      terminalRegistry.ensure(2, handlers());
      const first = terminalRegistry.getTerminal(2);
      terminalRegistry.ensure(2, handlers());
      const second = terminalRegistry.getTerminal(2);
      expect(first).toBe(second); // same instance
    });

    it('updates handlers on re-ensure (reconnect scenario)', () => {
      const h1 = handlers();
      const h2 = handlers();
      terminalRegistry.ensure(3, h1);
      terminalRegistry.ensure(3, h2);

      // Simulate input — should call h2.onInput, not h1.onInput
      const term = terminalRegistry.getTerminal(3) as any;
      term.simulateInput('x');

      expect(h2.onInput).toHaveBeenCalled();
      expect(h1.onInput).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────
  // onData → handlers.onInput (Uint8Array)
  // ──────────────────────────────────────────────────────────
  describe('onData → onInput', () => {
    it('encodes text input as Uint8Array and calls handlers.onInput', () => {
      const h = handlers();
      terminalRegistry.ensure(10, h);

      const term = terminalRegistry.getTerminal(10) as any;
      term.simulateInput('hello');

      expect(h.onInput).toHaveBeenCalledTimes(1);
      const arg = (h.onInput as ReturnType<typeof vi.fn>).mock.calls[0][0] as Uint8Array;
      expect(arg).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(arg)).toBe('hello');
    });
  });

  // ──────────────────────────────────────────────────────────
  // onBinary → handlers.onInput (Uint8Array)
  // ──────────────────────────────────────────────────────────
  describe('onBinary → onInput', () => {
    it('encodes binary input as Uint8Array and calls handlers.onInput', () => {
      const h = handlers();
      terminalRegistry.ensure(11, h);

      const term = terminalRegistry.getTerminal(11) as any;
      // simulateBinaryInput is added to the mock in setup.ts
      term.simulateBinaryInput('\x01\x02\x03');

      expect(h.onInput).toHaveBeenCalledTimes(1);
      const arg = (h.onInput as ReturnType<typeof vi.fn>).mock.calls[0][0] as Uint8Array;
      expect(arg).toBeInstanceOf(Uint8Array);
      expect(arg[0]).toBe(1);
      expect(arg[1]).toBe(2);
      expect(arg[2]).toBe(3);
    });
  });

  // ──────────────────────────────────────────────────────────
  // onResize — idempotent (no duplicate calls)
  // ──────────────────────────────────────────────────────────
  describe('onResize', () => {
    it('calls handlers.onResize when dimensions change', () => {
      const h = handlers();
      terminalRegistry.ensure(20, h);
      const term = terminalRegistry.getTerminal(20) as any;

      // Trigger resize
      for (const cb of term._onResizeCbs) cb({ cols: 120, rows: 40 });

      expect(h.onResize).toHaveBeenCalledWith(120, 40);
    });

    it('suppresses onResize when cols/rows unchanged (idempotent)', () => {
      const h = handlers();
      terminalRegistry.ensure(21, h);
      const term = terminalRegistry.getTerminal(21) as any;

      for (const cb of term._onResizeCbs) cb({ cols: 80, rows: 24 });
      for (const cb of term._onResizeCbs) cb({ cols: 80, rows: 24 }); // same

      expect(h.onResize).toHaveBeenCalledTimes(1); // second call suppressed
    });
  });

  // ──────────────────────────────────────────────────────────
  // write — pre-ensure buffering
  // ──────────────────────────────────────────────────────────
  describe('write — pre-ensure buffering', () => {
    it('buffers write before ensure and drains into terminal after ensure+attach', () => {
      // Write BEFORE ensure
      terminalRegistry.write(30, 'buffered');

      // Now ensure
      terminalRegistry.ensure(30, handlers());
      const term = terminalRegistry.getTerminal(30) as any;

      // Data should be in pendingData at this point (not yet written to term)
      // — it will drain when the layout settles via _settleAndDrain.
      const container = makeContainer();
      terminalRegistry.attach(30, container);

      // attach() does NOT drain synchronously — layout must settle first.
      expect(term.getWrittenData().length).toBe(0);

      // Drive the settle explicitly (geometry + _settleAndDrain).
      settleEntry(30, container);

      // After settling, pendingData is flushed into term.write() in arrival order.
      const written = term.getWrittenData();
      const hasBuffered = written.some((u: Uint8Array) => {
        return new TextDecoder().decode(u) === 'buffered';
      });
      expect(hasBuffered).toBe(true);
    });

    it('write after ensure but before attach queues in pendingData and drains on settle', () => {
      terminalRegistry.ensure(31, handlers());
      terminalRegistry.write(31, 'pre-attach');

      const term = terminalRegistry.getTerminal(31) as any;
      // Not yet written to terminal (pre-attach)
      expect(term.getWrittenData().length).toBe(0);

      const container = makeContainer();
      terminalRegistry.attach(31, container);

      // Still not written — attach does NOT drain; layout must settle first.
      expect(term.getWrittenData().length).toBe(0);

      // Drive settle: stub geometry and invoke _settleAndDrain.
      settleEntry(31, container);

      const written = term.getWrittenData();
      const hasData = written.some((u: Uint8Array) =>
        new TextDecoder().decode(u) === 'pre-attach',
      );
      expect(hasData).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────
  // attach / detach
  // ──────────────────────────────────────────────────────────
  describe('attach', () => {
    it('calls term.open and appends hostEl into container', () => {
      terminalRegistry.ensure(40, handlers());
      const container = makeContainer();
      terminalRegistry.attach(40, container);

      // The mock's open() appends a canvas to hostEl; hostEl is in container
      expect(container.firstChild).toBeTruthy();
    });

    it('write after settle goes directly to terminal (ready=true)', () => {
      terminalRegistry.ensure(41, handlers());
      const container = makeContainer();
      terminalRegistry.attach(41, container);

      // Settle the layout first so ready flips to true.
      settleEntry(41, container);

      // Now write goes directly to term.write() (not buffered).
      terminalRegistry.write(41, 'direct');

      const term = terminalRegistry.getTerminal(41) as any;
      const hasData = term.getWrittenData().some((u: Uint8Array) =>
        new TextDecoder().decode(u) === 'direct',
      );
      expect(hasData).toBe(true);
    });

    it('write after attach but before settle is buffered in pendingData', () => {
      terminalRegistry.ensure(42, handlers());
      const container = makeContainer();
      terminalRegistry.attach(42, container);

      // Write while ready=false — must be buffered, NOT sent to terminal yet.
      terminalRegistry.write(42, 'not-yet-direct');

      const term = terminalRegistry.getTerminal(42) as any;
      expect(term.getWrittenData().length).toBe(0);

      // Settle — the buffered write is drained at the correct size.
      settleEntry(42, container);
      const hasData = term.getWrittenData().some((u: Uint8Array) =>
        new TextDecoder().decode(u) === 'not-yet-direct',
      );
      expect(hasData).toBe(true);
    });
  });

  describe('detach', () => {
    it('removes hostEl from container but does NOT dispose terminal', () => {
      terminalRegistry.ensure(50, handlers());
      const container = makeContainer();
      terminalRegistry.attach(50, container);
      expect(container.firstChild).toBeTruthy();

      terminalRegistry.detach(50);
      expect(container.firstChild).toBeNull();

      // Terminal still lives in registry
      expect(terminalRegistry.getTerminal(50)).toBeTruthy();
    });

    it('terminal remains writable after detach', () => {
      terminalRegistry.ensure(51, handlers());
      const container = makeContainer();
      terminalRegistry.attach(51, container);
      terminalRegistry.detach(51);

      // Should not throw
      expect(() => terminalRegistry.write(51, 'after-detach')).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────
  // resetAll
  // ──────────────────────────────────────────────────────────
  describe('resetAll', () => {
    it('writes \\x1bc (RIS) to all opened terminals', () => {
      terminalRegistry.ensure(60, handlers());
      terminalRegistry.ensure(61, handlers());

      const container60 = makeContainer();
      const container61 = makeContainer();
      terminalRegistry.attach(60, container60);
      terminalRegistry.attach(61, container61);

      // Clear write history so far
      const term60 = terminalRegistry.getTerminal(60) as any;
      const term61 = terminalRegistry.getTerminal(61) as any;
      term60._writtenData = [];
      term61._writtenData = [];

      terminalRegistry.resetAll();

      const ris60 = term60.getWrittenData().some(
        (u: Uint8Array) => new TextDecoder().decode(u) === '\x1bc',
      );
      const ris61 = term61.getWrittenData().some(
        (u: Uint8Array) => new TextDecoder().decode(u) === '\x1bc',
      );
      expect(ris60).toBe(true);
      expect(ris61).toBe(true);
    });

    it('clears pendingData for unopened terminals', () => {
      terminalRegistry.ensure(62, handlers());
      terminalRegistry.write(62, 'stale');
      // Not attached yet — terminal not opened
      terminalRegistry.resetAll();

      // After reset, attach then settle; the cleared pendingData must not appear.
      const container = makeContainer();
      terminalRegistry.attach(62, container);
      settleEntry(62, container);

      const term = terminalRegistry.getTerminal(62) as any;
      const written = term.getWrittenData();
      const hasStale = written.some(
        (u: Uint8Array) => new TextDecoder().decode(u) === 'stale',
      );
      expect(hasStale).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────
  // prune
  // ──────────────────────────────────────────────────────────
  describe('prune', () => {
    it('disposes terminals for paneIds not in liveIds', () => {
      terminalRegistry.ensure(70, handlers());
      terminalRegistry.ensure(71, handlers());

      const term70 = terminalRegistry.getTerminal(70) as any;
      const term71 = terminalRegistry.getTerminal(71) as any;
      const spy70 = vi.spyOn(term70, 'dispose');
      const spy71 = vi.spyOn(term71, 'dispose');

      // Keep 71, remove 70
      terminalRegistry.prune(new Set([71]));

      expect(spy70).toHaveBeenCalledTimes(1);
      expect(spy71).not.toHaveBeenCalled();
      expect(terminalRegistry.getTerminal(70)).toBeNull();
      expect(terminalRegistry.getTerminal(71)).toBeTruthy();
    });

    it('also clears pre-ensure buffer for pruned paneIds', () => {
      // Write before ensure so it lands in pre-ensure buffer
      terminalRegistry.write(80, 'ghost-data');

      // Prune — paneId 80 is dead (not in liveIds)
      terminalRegistry.prune(new Set([]));

      // Now ensure — should have NO buffered data
      terminalRegistry.ensure(80, handlers());
      const container = makeContainer();
      terminalRegistry.attach(80, container);
      // Settle so any pending data (there should be none) would have been drained.
      settleEntry(80, container);

      const term = terminalRegistry.getTerminal(80) as any;
      const hasGhost = term.getWrittenData().some(
        (u: Uint8Array) => new TextDecoder().decode(u) === 'ghost-data',
      );
      expect(hasGhost).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────
  // getTerminal
  // ──────────────────────────────────────────────────────────
  describe('getTerminal', () => {
    it('returns null for unknown paneId', () => {
      expect(terminalRegistry.getTerminal(9999)).toBeNull();
    });

    it('returns the Terminal instance after ensure', () => {
      terminalRegistry.ensure(90, handlers());
      const term = terminalRegistry.getTerminal(90);
      expect(term).toBeTruthy();
    });
  });

  // ────────────────────────────────────────────────────────────
  // snapshot
  // ────────────────────────────────────────────────────────────
  describe('snapshot', () => {
    it('returns null for unknown paneId', () => {
      expect(terminalRegistry.snapshot(9999)).toBeNull();
    });

    it('window.__muxterm.snapshot is a function and returns null for unknown paneId', () => {
      const muxterm = (window as unknown as { __muxterm?: Record<string, unknown> }).__muxterm;
      expect(typeof muxterm?.snapshot).toBe('function');
      const snapFn = muxterm!.snapshot as (paneId: number) => unknown;
      expect(snapFn(9999)).toBeNull();
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// buildTerminalConfig / configureTerminals
// ────────────────────────────────────────────────────────────────────
describe('buildTerminalConfig', () => {
  it('returns defaults matching DEFAULT_RESOLVED_CONFIG', () => {
    const cfg = buildTerminalConfig(DEFAULT_RESOLVED_CONFIG);
    expect(cfg.fontSize).toBe(13);
    expect(cfg.cursorStyle).toBe('block');
    expect(cfg.cursorBlink).toBe(true);
    expect(cfg.scrollback).toBe(10000);
    expect(cfg.theme).toStrictEqual(resolvePalette('tokyo-night'));
  });

  it('returns overrides when given a custom config', () => {
    const custom = {
      ...DEFAULT_RESOLVED_CONFIG,
      theme: { palette: 'gruvbox' },
      font: { family: 'Iosevka', size: 18 },
      terminal: {
        ...DEFAULT_RESOLVED_CONFIG.terminal,
        cursorStyle: 'bar' as const,
        cursorBlink: false,
        scrollback: 99999,
      },
    };
    const cfg = buildTerminalConfig(custom);
    expect(cfg.fontFamily).toBe('Iosevka');
    expect(cfg.fontSize).toBe(18);
    expect(cfg.cursorStyle).toBe('bar');
    expect(cfg.cursorBlink).toBe(false);
    expect(cfg.scrollback).toBe(99999);
    expect(cfg.theme).toStrictEqual(resolvePalette('gruvbox'));
  });

  it('always sets non-overridable fields (lineHeight, allowTransparency, convertEol)', () => {
    const cfg = buildTerminalConfig(DEFAULT_RESOLVED_CONFIG);
    expect(cfg.lineHeight).toBe(1.0);
    expect(cfg.allowTransparency).toBe(false);
    expect(cfg.convertEol).toBe(false);
  });
});
