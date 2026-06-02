// Responsive viewport classification for the browser multiplexer.
//
// Breakpoints borrow from responsive web design:
//   wide   (desktop/ultrawide) = tiling, all peers visible
//   medium (tablet/laptop)     = tiling, fewer simultaneous splits
//   narrow (phone/portrait)    = tabbed, one peer visible
//
// Pure logic only: nothing here touches the DOM, localStorage, or network.

export type ViewportClass = 'wide' | 'medium' | 'narrow';

/** Lower bounds, in CSS pixels, for each viewport class. */
export const BREAKPOINTS = {
  WIDE_MIN: 1024,
  MEDIUM_MIN: 640,
} as const;

/** Classify a viewport width (CSS px) into a responsive layout class. */
export function viewportClassFor(widthPx: number): ViewportClass {
  if (widthPx >= BREAKPOINTS.WIDE_MIN) return 'wide';
  if (widthPx >= BREAKPOINTS.MEDIUM_MIN) return 'medium';
  return 'narrow';
}
