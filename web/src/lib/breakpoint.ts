// Two layout modes, by viewport width:
//   wide   (>= 768px) — tablet + PC: dockview with splits, layout saved/restored
//   narrow (<  768px) — phone: tab view only, no layout persistence
//
// The single 'wide' string is also the server-side layout storage key. Narrow
// never saves or restores a layout.
export type LayoutMode = 'wide' | 'narrow';

/** Width (px) at/above which we use the wide (dockview + splits) layout. */
export const WIDE_MIN_WIDTH = 768;

/** Map a viewport width (px) to a layout mode. */
export function layoutModeForWidth(width: number): LayoutMode {
  return width >= WIDE_MIN_WIDTH ? 'wide' : 'narrow';
}

/** Current layout mode from window.innerWidth (falls back to 'wide' in non-DOM env). */
export function currentLayoutMode(): LayoutMode {
  if (typeof window === 'undefined') return 'wide';
  return layoutModeForWidth(window.innerWidth);
}

/** True when the viewport is wide enough for the dockview split layout. */
export function isWide(): boolean {
  return currentLayoutMode() === 'wide';
}
