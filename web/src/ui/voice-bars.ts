import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';

/** Decorative voice level meter shared by Chat's start and stop actions. */
@customElement('mux-ui-voice-bars')
export class MuxUIVoiceBars extends LitElement {
  static override styles = css`
    :host { display:inline-flex; align-items:center; justify-content:center; gap:var(--ui-space-1); height:var(--ui-voice-meter-height); }
    i { display:block; width:var(--ui-voice-meter-bar-width); border-radius:var(--ui-radius-pill); background:currentColor; transition:height .075s ease-out; }
    i:nth-child(1) { height:var(--ui-voice-meter-rest-1); }
    i:nth-child(2) { height:var(--ui-voice-meter-rest-2); }
    i:nth-child(3) { height:var(--ui-voice-meter-rest-3); }
    i:nth-child(4) { height:var(--ui-voice-meter-rest-4); }
    @media (prefers-reduced-motion:reduce) { i { transition:none; } }
  `;

  setLevels(levels: readonly number[]): void {
    const resting = [4, 6, 6, 4];
    this.renderRoot.querySelectorAll<HTMLElement>('i').forEach((bar, index) => {
      bar.style.height = `${Math.round(resting[index] + Math.min(1, levels[index] || 0) * 10)}px`;
    });
  }

  override render() { return html`<i></i><i></i><i></i><i></i>`; }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-voice-bars': MuxUIVoiceBars } }
