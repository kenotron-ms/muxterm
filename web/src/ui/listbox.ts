import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';

export type ListboxPresentation = 'popover' | 'suggestions' | 'embedded';

/** Shared option navigation for controls that keep DOM focus on their trigger. */
export function listboxIndexForKey(key: string, current: number, count: number): number | null {
  if (!count) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowUp') return (current - 1 + count) % count;
  return null;
}

/** A token-based listbox surface for select-only and editable comboboxes. */
@customElement('mux-ui-listbox')
export class MuxUIListbox extends LitElement {
  @property() label = '';
  @property({ reflect:true }) presentation: ListboxPresentation = 'popover';

  static override styles = css`
    ${subtleScrollbars}
    :host {
      box-sizing:border-box; display:block; z-index:var(--ui-z-dropdown); overflow:auto; padding:var(--ui-space-2);
      border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg);
      background:var(--ui-surface-raised); background-image:var(--ui-overlay-backdrop-image); box-shadow:var(--ui-shadow-menu);
      color:var(--ui-text); font:var(--ui-text-sm)/1.4 var(--ui-font-sans);
    }
    :host([presentation='popover']) {
      position:absolute; top:calc(var(--ui-control-md) + var(--ui-space-1)); left:0;
      width:min(var(--ui-listbox-width,var(--ui-picker-width)),calc(100vw - var(--ui-space-8)));
      max-height:var(--ui-menu-max-height);
    }
    :host([presentation='suggestions']) {
      position:absolute; bottom:calc(100% - var(--ui-space-px)); left:50%; transform:translateX(-50%);
      width:min(var(--ui-listbox-width,var(--ui-dialog-width)),calc(100% - var(--ui-space-8)));
      max-height:var(--ui-menu-max-height);
    }
    ::slotted([role='separator']) { display:block; height:1px; margin:var(--ui-space-3) var(--ui-space-2); background:var(--ui-border); }
    @media(max-width:700px) {
      :host([presentation='popover']) {
        position:fixed; z-index:var(--ui-z-sheet); inset:auto 0 0; width:100vw; max-height:min(78dvh,var(--ui-dialog-height));
        padding:var(--ui-space-6) var(--ui-space-6) calc(var(--ui-space-6) + env(safe-area-inset-bottom));
        border-radius:var(--ui-radius-xl) var(--ui-radius-xl) 0 0; border-bottom:0; box-shadow:var(--ui-shadow-sheet);
      }
      :host([presentation='popover'])::before { content:''; display:block; width:var(--ui-control-md); height:var(--ui-space-2); margin:0 auto var(--ui-space-5); border-radius:var(--ui-radius-pill); background:var(--ui-border); }
      :host([presentation='suggestions']) { width:calc(100% - var(--ui-space-4)); }
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('role', 'listbox');
    this.syncLabel();
  }
  private syncLabel(): void {
    if (this.label) this.setAttribute('aria-label', this.label);
    else this.removeAttribute('aria-label');
  }
  override updated(): void { this.syncLabel(); }
  override render() { return html`<slot></slot>`; }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-listbox': MuxUIListbox } }
