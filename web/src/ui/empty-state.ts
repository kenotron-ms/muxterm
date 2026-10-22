import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

export type EmptyStateAppearance = 'app' | 'document';

/** A full-panel empty view with one clear next action. */
@customElement('mux-ui-empty-state')
export class MuxUIEmptyState extends LitElement {
  @property() heading = '';
  @property({ reflect: true }) appearance: EmptyStateAppearance = 'app';
  @state() private hasAction = false;

  static override styles = css`
    :host {
      --empty-text: var(--ui-text);
      --empty-muted: var(--ui-text-muted);
      --empty-accent: var(--ui-accent);
      box-sizing: border-box;
      display: flex;
      flex: 1;
      min-width: 0;
      min-height: 0;
      align-items: center;
      justify-content: center;
      padding: var(--ui-space-8);
      color: var(--empty-muted);
      font: var(--ui-text-sm)/1.5 var(--ui-font-sans);
      text-align: center;
    }
    :host([appearance='document']) {
      --empty-text: var(--ui-document-text);
      --empty-muted: var(--ui-document-muted);
      --empty-accent: var(--ui-document-accent);
    }
    .content { display: flex; width: 100%; max-width: 340px; flex-direction: column; align-items: center; }
    .icon {
      display: grid;
      width: var(--ui-control-lg);
      height: var(--ui-control-lg);
      flex: none;
      place-items: center;
      border-radius: var(--ui-radius-lg);
      background: color-mix(in srgb, var(--empty-accent) 12%, transparent);
      color: var(--empty-accent);
    }
    .icon ::slotted(*) { display: inline-flex; align-items: center; justify-content: center; }
    h2 { margin: var(--ui-space-5) 0 var(--ui-space-2); color: var(--empty-text); font: 650 var(--ui-text-xl)/1.25 var(--ui-font-sans); }
    .description { max-width: 32ch; }
    .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--ui-space-3); margin-top: var(--ui-space-6); }
    .actions[hidden] { display: none; }
  `;

  private onActionSlotChange(event: Event): void {
    this.hasAction = (event.target as HTMLSlotElement).assignedElements({ flatten: true }).length > 0;
  }

  override render() {
    return html`<section class="content" aria-label=${this.heading}>
      <div class="icon" aria-hidden="true"><slot name="icon"></slot></div>
      <h2>${this.heading}</h2>
      <div class="description"><slot></slot></div>
      <div class="actions" ?hidden=${!this.hasAction}><slot name="action" @slotchange=${this.onActionSlotChange}></slot></div>
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'mux-ui-empty-state': MuxUIEmptyState }
}
