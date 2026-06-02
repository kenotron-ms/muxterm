import { describe, it, expect } from 'vitest';
import { viewportClassFor } from '../lib/layout.js';

describe('viewportClassFor', () => {
  it('classifies wide viewports', () => {
    expect(viewportClassFor(1280)).toBe('wide');
    expect(viewportClassFor(1024)).toBe('wide');
  });

  it('classifies medium viewports', () => {
    expect(viewportClassFor(900)).toBe('medium');
    expect(viewportClassFor(640)).toBe('medium');
  });

  it('classifies narrow viewports', () => {
    expect(viewportClassFor(480)).toBe('narrow');
    expect(viewportClassFor(0)).toBe('narrow');
  });

  it('is monotonic with no gaps at the breakpoints', () => {
    expect(viewportClassFor(639)).toBe('narrow');
    expect(viewportClassFor(640)).toBe('medium');
    expect(viewportClassFor(1023)).toBe('medium');
    expect(viewportClassFor(1024)).toBe('wide');
  });
});
