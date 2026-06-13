/**
 * mux-sidebar.ts unit tests
 * TDD: tests written before implementation to define the exported API.
 */
import { describe, it, expect } from 'vitest';
import {
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  MuxSidebar,
} from '../components/mux-sidebar.js';

describe('mux-sidebar constants', () => {
  it('exports SIDEBAR_WIDTH_KEY', () => {
    expect(SIDEBAR_WIDTH_KEY).toBe('mux-sidebar-width');
  });

  it('exports SIDEBAR_DEFAULT_WIDTH = 220', () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(220);
  });

  it('exports SIDEBAR_MIN_WIDTH = 160', () => {
    expect(SIDEBAR_MIN_WIDTH).toBe(160);
  });

  it('exports SIDEBAR_MAX_WIDTH = 360', () => {
    expect(SIDEBAR_MAX_WIDTH).toBe(360);
  });
});

describe('MuxSidebar class', () => {
  it('is a constructor function (a class)', () => {
    expect(typeof MuxSidebar).toBe('function');
  });

  it('has restoreWorkspace as a public method on the prototype', () => {
    expect(typeof MuxSidebar.prototype.restoreWorkspace).toBe('function');
  });
});
