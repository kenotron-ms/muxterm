import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import { floatPopup, type PopupReference } from '../lib/floating-popup.js';

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
  @property({ attribute:false }) reference: PopupReference | null = null;
  private stopFloating?: () => void;

  static override styles = css`
    ${subtleScrollbars}
    :host {
      box-sizing:border-box; display:block; z-index:var(--ui-z-dropdown); overflow:auto; padding:var(--ui-space-2);
      border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg);
      background:var(--ui-surface-raised); background-image:var(--ui-overlay-backdrop-image); box-shadow:var(--ui-shadow-menu);
      color:var(--ui-text); font:var(--ui-text-sm)/1.4 var(--ui-font-sans);
    }
    :host([presentation='popover']) {
      position:absolute; top:0; left:0;
      width:min(var(--ui-listbox-width,var(--ui-picker-width)),calc(100vw - var(--ui-space-8)));
      max-height:var(--ui-menu-max-height);
    }
    :host([presentation='suggestions']) {
      position:absolute; top:0; left:0;
      width:min(var(--ui-listbox-width,var(--ui-dialog-width)),var(--floating-reference-width,100vw));
      max-height:var(--ui-menu-max-height);
    }
    ::slotted([role='separator']) { display:block; height:var(--ui-divider-thickness); margin:var(--ui-space-3) var(--ui-space-2); background:var(--ui-border); }
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
  override disconnectedCallback(): void {
    this.stopFloating?.();
    this.stopFloating = undefined;
    super.disconnectedCallback();
  }
  private syncLabel(): void {
    if (this.label) this.setAttribute('aria-label', this.label);
    else this.removeAttribute('aria-label');
  }
  override updated(changed: Map<string, unknown>): void {
    this.syncLabel();
    if (this.presentation === 'embedded') {
      this.stopFloating?.();
      this.stopFloating = undefined;
      return;
    }
    if (!this.stopFloating || changed.has('reference') || changed.has('presentation')) {
      this.stopFloating?.();
      const reference = this.reference || this.previousElementSibling || this.parentElement;
      if (reference) this.stopFloating = floatPopup(reference, this, this.presentation === 'suggestions' ? 'top' : 'bottom-start', this.presentation === 'suggestions' ? 1 : 6, this.presentation !== 'suggestions');
    }
  }
  override render() { return html`<slot></slot>`; }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-listbox': MuxUIListbox } }
