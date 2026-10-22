import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** Shared heading for a full app surface, below the workspace title bar. */
@customElement('mux-ui-page-intro')
export class MuxUIPageIntro extends LitElement {
  @property() eyebrow = '';
  @property() heading = '';
  @property() description = '';

  static override styles = css`
    :host {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--ui-space-7);
      min-width: 0;
      padding: var(--ui-space-7) var(--ui-space-8);
      border-bottom: 1px solid var(--ui-border);
      background: var(--ui-surface-base);
      color: var(--ui-text);
      font-family: var(--ui-font-sans);
    }
    .copy { min-width: 0; }
    .eyebrow { margin-bottom: var(--ui-space-2); color: var(--ui-accent); font-size: var(--ui-text-xs); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: var(--ui-text-3xl); font-weight: 650; line-height: 1.2; letter-spacing: -.02em; }
    p { margin: var(--ui-space-3) 0 0; color: var(--ui-text-muted); font-size: var(--ui-text-md); line-height: 1.45; }
    .action { flex: none; }
    .action:empty { display: none; }
    @media (max-width: 600px) {
      :host { align-items: flex-start; flex-direction: column; gap: var(--ui-space-5); padding: var(--ui-space-6); }
    }
  `;

  override render() {
    return html`<div class="copy">${this.eyebrow ? html`<div class="eyebrow">${this.eyebrow}</div>` : nothing}<h1>${this.heading}</h1>${this.description ? html`<p>${this.description}</p>` : nothing}</div><div class="action"><slot name="action"></slot></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'mux-ui-page-intro': MuxUIPageIntro }
}
