import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { subtleScrollbars } from '../lib/subtle-scrollbars.js';
import './menu-item.js';

/** An action menu for shared Menu Items. */
@customElement('mux-ui-menu')
export class MuxUIMenu extends LitElement {
  @property() label = 'Actions';

  static override styles = css`
    ${subtleScrollbars}
    :host {
      box-sizing:border-box; display:block; position:absolute; z-index:var(--ui-z-menu);
      top:var(--ui-menu-offset-y,var(--ui-control-sm)); right:var(--ui-menu-offset-x,var(--ui-space-2));
      width:max-content; min-width:var(--ui-menu-min-width); max-width:min(var(--ui-menu-width,var(--ui-picker-width)),calc(100vw - var(--ui-space-8)));
      max-height:var(--ui-menu-max-height); overflow:auto; padding:var(--ui-space-2);
      border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg);
      background:var(--ui-surface-raised); background-image:var(--ui-overlay-backdrop-image); box-shadow:var(--ui-shadow-menu);
      color:var(--ui-text); font:var(--ui-text-sm)/1.4 var(--ui-font-sans);
    }
    ::slotted([role='separator']) { display:block; height:1px; margin:var(--ui-space-3) var(--ui-space-2); background:var(--ui-border); }
    @media(max-width:700px) {
      :host {
        position:fixed; z-index:var(--ui-z-sheet); inset:auto 0 0; width:100vw; min-width:0; max-width:none;
        max-height:min(78dvh,var(--ui-dialog-height)); padding:var(--ui-space-6) var(--ui-space-6) calc(var(--ui-space-6) + env(safe-area-inset-bottom));
        border-radius:var(--ui-radius-xl) var(--ui-radius-xl) 0 0; border-bottom:0; box-shadow:var(--ui-shadow-sheet);
      }
      :host::before { content:''; display:block; width:var(--ui-control-md); height:var(--ui-space-2); margin:0 auto var(--ui-space-5); border-radius:var(--ui-radius-pill); background:var(--ui-border); }
    }
  `;

  private items(): HTMLElement[] {
    const slot = this.renderRoot.querySelector('slot');
    return (slot?.assignedElements({ flatten:true }) ?? []).filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element.tagName === 'MUX-UI-MENU-ITEM' && !element.hasAttribute('disabled'));
  }
  focusFirst(): void { this.items()[0]?.focus(); }

  private onKeyDown(event: KeyboardEvent): void {
    const items = this.items();
    const path = event.composedPath();
    const current = items.findIndex(item => path.includes(item));
    let next = current;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      this.dispatchEvent(new CustomEvent('menu-dismiss', { bubbles:true, composed:true, detail:{ restoreFocus:event.key === 'Escape' } }));
      return;
    } else return;
    if (!items.length) return;
    event.preventDefault();
    items[next]?.focus();
  }

  override render() {
    return html`<div role="menu" aria-label=${this.label || nothing} @keydown=${this.onKeyDown}><slot @slotchange=${this.focusFirst}></slot></div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-menu': MuxUIMenu } }
