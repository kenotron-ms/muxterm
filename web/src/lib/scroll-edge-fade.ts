import { css } from 'lit';

// Fade only the content that can scroll past an edge. Keeping the distances in
// CSS lets the mask ease in during the first few pixels of a scroll.
export const scrollEdgeFadeStyles = css`
  .scroll-edge-fade {
    --scroll-edge-top-fade: 0px;
    --scroll-edge-bottom-fade: 0px;
    -webkit-mask-image: linear-gradient(to bottom, transparent, #000 var(--scroll-edge-top-fade), #000 calc(100% - var(--scroll-edge-bottom-fade)), transparent);
    mask-image: linear-gradient(to bottom, transparent, #000 var(--scroll-edge-top-fade), #000 calc(100% - var(--scroll-edge-bottom-fade)), transparent);
  }
`;

export function syncScrollEdgeFade(viewport: HTMLElement, maxFade: number): void {
  const remaining = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const top = `${Math.round(Math.min(maxFade, Math.max(0, viewport.scrollTop)))}px`;
  const bottom = `${Math.round(Math.min(maxFade, Math.max(0, remaining - viewport.scrollTop)))}px`;
  if (viewport.style.getPropertyValue('--scroll-edge-top-fade') !== top) viewport.style.setProperty('--scroll-edge-top-fade', top);
  if (viewport.style.getPropertyValue('--scroll-edge-bottom-fade') !== bottom) viewport.style.setProperty('--scroll-edge-bottom-fade', bottom);
}
