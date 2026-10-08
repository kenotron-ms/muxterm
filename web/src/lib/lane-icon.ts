import { html } from 'lit';

/** A trunk with two task branches; color is inherited from the lane state. */
export function laneIcon(size = 16) {
  return html`<svg width=${size} height=${size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 3.5v13M4 6.5h5M4 13.5h5" />
    <rect x="9" y="3.5" width="7" height="6" rx="1.5" />
    <rect x="9" y="10.5" width="7" height="6" rx="1.5" />
  </svg>`;
}
