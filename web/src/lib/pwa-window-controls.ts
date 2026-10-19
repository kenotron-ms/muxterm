import { syncPwaThemeColor } from './theme.js';

interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

/** Reserve only the browser-owned control areas of an installed desktop PWA. */
export function installPwaWindowControls(root: HTMLElement = document.documentElement): () => void {
  const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay })
    .windowControlsOverlay;
  const update = (): void => {
    if (!overlay?.visible) {
      delete root.dataset.wcoControls;
      root.style.removeProperty('--wco-left-inset');
      root.style.removeProperty('--wco-right-inset');
      syncPwaThemeColor(root);
      return;
    }
    const area = overlay.getTitlebarAreaRect();
    const left = Math.max(0, area.x);
    const right = Math.max(0, window.innerWidth - area.right);
    root.style.setProperty('--wco-left-inset', `${left ? left + 8 : 0}px`);
    root.style.setProperty('--wco-right-inset', `${right ? right + 8 : 0}px`);
    root.dataset.wcoControls = left > 0 ? 'left' : 'right';
    syncPwaThemeColor(root);
  };
  overlay?.addEventListener('geometrychange', update);
  window.addEventListener('resize', update);
  update();
  return () => {
    overlay?.removeEventListener('geometrychange', update);
    window.removeEventListener('resize', update);
  };
}
