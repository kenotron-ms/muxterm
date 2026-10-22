import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'info' | 'danger';
export type StatusBadgeAppearance = 'pill' | 'plain';

/** Short, textual state label. The optional dot adds a visual cue but never
 * replaces the text that names the state. */
@customElement('mux-ui-status-badge')
export class MuxUIStatusBadge extends LitElement {
  @property({ reflect: true }) tone: StatusTone = 'neutral';
  @property({ reflect: true }) appearance: StatusBadgeAppearance = 'pill';
  @property({ type: Boolean, reflect: true }) dot = false;
  @property({ type: Boolean, reflect: true }) wrap = false;

  static override styles = css`
    :host {
      --badge-tone: var(--ui-text-muted);
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: var(--ui-space-3);
      max-width: 100%;
      min-height: var(--ui-control-sm);
      padding: var(--ui-space-2) var(--ui-space-5);
      border: 1px solid color-mix(in srgb, var(--badge-tone) 27%, var(--ui-border));
      border-radius: var(--ui-radius-pill);
      background: color-mix(in srgb, var(--badge-tone) 10%, var(--ui-surface-raised));
      color: var(--ui-text);
      font: 600 var(--ui-text-xs)/1.3 var(--ui-font-sans);
      white-space: nowrap;
    }
    :host([tone='success']) { --badge-tone: var(--ui-success); }
    :host([tone='warning']) { --badge-tone: var(--ui-warning); }
    :host([tone='info']) { --badge-tone: var(--ui-accent); }
    :host([tone='danger']) { --badge-tone: var(--ui-danger); }
    :host([appearance='plain']) {
      min-height: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--badge-tone);
      font: inherit;
    }
    :host([wrap]) { white-space: normal; overflow-wrap: anywhere; }
    .dot { display: none; flex: none; width: var(--ui-status-dot-size); height: var(--ui-status-dot-size); border-radius: 50%; background: var(--badge-tone); }
    :host([dot]) .dot { display: block; }
  `;

  override render() {
    return html`<span class="dot" aria-hidden="true"></span><slot></slot>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'mux-ui-status-badge': MuxUIStatusBadge }
}
