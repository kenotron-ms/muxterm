/**
 * The small, source-native mark shared by app voice controls.
 *
 * The circle and four rounded strokes are intentionally plain SVG. Their
 * scales only reflect a supplied, measured input level; this element creates
 * no timer, media graph, or simulated activity of its own.
 */

import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type VoiceModeIconState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

function limitedLevel(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

@customElement('mux-voice-mode-icon')
export class MuxVoiceModeIcon extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      width: 24px;
      height: 24px;
      color: inherit;
      flex: none;
    }

    svg {
      display: block;
      width: 100%;
      height: 100%;
      overflow: visible;
    }

    .circle,
    .bar {
      fill: none;
      stroke: currentColor;
    }

    .circle {
      stroke-width: 1.5;
    }

    .bar {
      stroke-width: 2.25;
      stroke-linecap: round;
      transform-box: fill-box;
      transform-origin: center;
      transition: transform 120ms ease-out;
    }

    @media (prefers-reduced-motion: reduce) {
      .bar {
        transition: none;
      }
    }
  `;

  @property({ type: String }) state: VoiceModeIconState = 'idle';
  @property({ type: Number }) level = 0;
  @property({ type: Boolean }) muted = false;

  override render() {
    const level = this.state === 'listening' && !this.muted ? limitedLevel(this.level) : 0;
    const scales = [
      0.68 + level * 0.32,
      0.5 + level * 0.5,
      0.78 + level * 0.22,
      0.58 + level * 0.42,
    ];

    return html`
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle class="circle" cx="12" cy="12" r="9"></circle>
        <path class="bar" style="transform:scaleY(${scales[0]})" d="M8.1 14.2V9.8"></path>
        <path class="bar" style="transform:scaleY(${scales[1]})" d="M10.7 16.1V7.9"></path>
        <path class="bar" style="transform:scaleY(${scales[2]})" d="M13.3 15.1V8.9"></path>
        <path class="bar" style="transform:scaleY(${scales[3]})" d="M15.9 13.5v-3"></path>
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-voice-mode-icon': MuxVoiceModeIcon;
  }
}