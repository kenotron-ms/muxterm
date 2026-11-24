import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

export type ExternalLinkPreference = 'normal' | 'ask';
const PREFERENCE_KEY = 'muxterm.external-links.tap-choice';

export function externalLinkPreference(): ExternalLinkPreference {
  try { return localStorage.getItem(PREFERENCE_KEY) === 'ask' ? 'ask' : 'normal'; }
  catch { return 'normal'; }
}

export function setExternalLinkPreference(value: ExternalLinkPreference): void {
  try { localStorage.setItem(PREFERENCE_KEY, value); } catch { /* Private browsing can reject storage. */ }
}

let androidPwaCache: boolean | null = null;
export function isAndroidPwa(): boolean {
  androidPwaCache ??= /Android/i.test(navigator.userAgent) && window.matchMedia('(display-mode: standalone)').matches;
  return androidPwaCache;
}

function externalURL(href: string): string | null {
  try {
    const parsed = new URL(href, document.baseURI);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin === location.origin) return null;
    // An absolute href is passed through unchanged, including its query and fragment.
    return /^https?:\/\//i.test(href) ? href : parsed.href;
  } catch { return null; }
}

function linkURL(anchor: HTMLAnchorElement): string | null {
  return externalURL(anchor.getAttribute('href') || anchor.href);
}

function anchorFromEvent(event: Event): HTMLAnchorElement | null {
  const path = event.composedPath();
  if (path.some(node => node instanceof Element && (node.hasAttribute('download') || node.hasAttribute('data-external-link-bypass')))) return null;
  return path.find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement) ?? null;
}

@customElement('mux-external-link-actions')
class ExternalLinkActions extends LitElement {
  @state() private url = '';
  @state() private message = '';
  @state() private copyFallback = false;
  private returnFocus: HTMLElement | null = null;

  static override styles = css`
    :host { display:block; position:fixed; inset:0; box-sizing:border-box; width:100vw; height:100dvh; margin:0; padding:0; border:0; background:transparent; z-index:calc(var(--ui-z-reconnect-overlay) + 1); font:var(--ui-text-md)/1.4 var(--ui-font-sans); color:var(--ui-text); }
    .scrim { position:absolute; inset:0; background:rgba(0,0,0,.48); }
    .panel { position:absolute; box-sizing:border-box; top:50%; left:50%; transform:translate(-50%,-50%); width:min(420px,calc(100vw - 32px)); max-height:calc(100dvh - 32px); overflow:auto; padding:var(--ui-space-6); border:1px solid var(--ui-border); border-radius:var(--ui-radius-xl); background:var(--ui-surface-raised); box-shadow:var(--ui-shadow-menu); }
    h2 { margin:0 0 var(--ui-space-1); font-size:var(--ui-text-lg); line-height:1.25; }
    .url { margin:0 0 var(--ui-space-5); color:var(--ui-text-muted); font-size:var(--ui-text-sm); overflow-wrap:anywhere; }
    .actions { display:grid; gap:var(--ui-space-1); }
    button { box-sizing:border-box; width:100%; min-height:var(--ui-control-lg); padding:var(--ui-space-3) var(--ui-space-4); border:0; border-radius:var(--ui-radius-md); background:transparent; color:var(--ui-text); font:inherit; text-align:left; cursor:pointer; }
    button:hover, button:focus-visible { background:var(--ui-surface-hover); }
    button:focus-visible, input:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    button:disabled { opacity:.55; cursor:default; }
    .hint, .message { margin:var(--ui-space-5) 0 0; color:var(--ui-text-muted); font-size:var(--ui-text-sm); line-height:1.45; }
    .message { color:var(--ui-text); }
    input { box-sizing:border-box; width:100%; margin-top:var(--ui-space-3); padding:var(--ui-space-3); border:1px solid var(--ui-border); border-radius:var(--ui-radius-sm); background:var(--ui-surface); color:var(--ui-text); font:var(--ui-text-sm) var(--ui-font-sans); }
    @media(max-width:700px) { .panel { top:auto; bottom:0; left:0; transform:none; width:100%; max-height:85dvh; padding:var(--ui-space-6) var(--ui-space-6) calc(var(--ui-space-6) + env(safe-area-inset-bottom)); border-radius:var(--ui-radius-xl) var(--ui-radius-xl) 0 0; } .panel::before { content:''; display:block; width:var(--ui-control-md); height:var(--ui-space-1); margin:0 auto var(--ui-space-5); border-radius:100px; background:var(--ui-border-strong); } }
  `;

  show(url: string, returnFocus: HTMLElement | null): void {
    this.url = url;
    this.message = '';
    this.copyFallback = false;
    this.returnFocus = returnFocus;
    this.setAttribute('popover', 'manual');
    if (!this.isConnected) document.body.append(this);
    if (!this.matches(':popover-open')) this.showPopover();
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>('button[data-first]')?.focus());
  }

  private close(): void {
    if (this.matches(':popover-open')) this.hidePopover();
    this.remove();
    this.returnFocus?.focus({ preventScroll:true });
    this.returnFocus = null;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
    if (event.key !== 'Tab') return;
    const controls = Array.from(this.renderRoot.querySelectorAll<HTMLElement>('button:not(:disabled), input'));
    if (!controls.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && this.shadowRoot?.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && this.shadowRoot?.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  private openNormally(): void {
    window.open(this.url, '_blank', 'noopener,noreferrer');
    this.close();
  }

  private async share(): Promise<void> {
    if (!navigator.share) { this.message = 'Sharing is unavailable here. Copy the link and paste it in your work browser.'; return; }
    try {
      await navigator.share({ url:this.url });
      this.close();
    } catch (error) {
      this.message = error instanceof DOMException && error.name === 'AbortError'
        ? 'Sharing was cancelled. You can still copy the link.'
        : 'The system could not share this link. Copy it and paste it in your work browser.';
    }
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.url);
      this.message = 'Link copied. Paste it in your work browser.';
    } catch {
      this.copyFallback = true;
      this.message = 'Select and copy this link, then paste it in your work browser.';
      void this.updateComplete.then(() => { const input = this.renderRoot.querySelector<HTMLInputElement>('input'); input?.focus(); input?.select(); });
    }
  }

  override render() {
    const host = this.url ? new URL(this.url).host : '';
    return html`<div class="scrim" @click=${this.close}></div>
      <section class="panel" role="dialog" aria-modal="true" aria-label="Link actions" @keydown=${this.onKeyDown}>
        <h2>Open link</h2><p class="url">${host}<br>${this.url}</p>
        <div class="actions">
          <button data-first type="button" @click=${this.openNormally}>Open normally</button>
          <button type="button" @click=${this.share}>Share / Open with…</button>
          <button type="button" @click=${this.copy}>Copy link</button>
        </div>
        ${this.message ? html`<p class="message" role="status">${this.message}</p>` : nothing}
        ${this.copyFallback ? html`<input aria-label="Link to copy" readonly .value=${this.url}>` : nothing}
        <p class="hint">Android decides which apps appear in Share. Your organization may limit work apps; Muxterm cannot override that policy.</p>
      </section>`;
  }
}

let menu: ExternalLinkActions | null = null;
function showActions(url: string, focusTarget: HTMLElement | null): void {
  menu ??= document.createElement('mux-external-link-actions');
  menu.show(url, focusTarget);
}

/** Used by the terminal link addon, whose links are rendered as cells rather than anchors. */
let suppressTerminalLinkUntil = 0;
let suppressTouchClickUntil = 0;
// Both anchor and terminal long-press paths arm this; the document capture
// listener suppresses the synthetic click from that same finger release.
let suppressReleaseClick = false;
export function openTerminalLink(event: MouseEvent, uri: string): void {
  if (Date.now() < suppressTerminalLinkUntil) return;
  const url = externalURL(uri);
  if (!url) { window.open(uri, '_blank', 'noopener,noreferrer'); return; }
  if (isAndroidPwa() && externalLinkPreference() === 'ask') showActions(url, event.target as HTMLElement);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export function showTerminalLinkActions(uri: string, focusTarget: HTMLElement | null, fromTouch = false): boolean {
  const url = externalURL(uri);
  if (!url) return false;
  showActions(url, focusTarget);
  suppressTerminalLinkUntil = Date.now() + 1200;
  if (fromTouch) suppressReleaseClick = true;
  return true;
}

let installed = false;
export function installExternalLinkHandling(): void {
  if (installed) return;
  installed = true;
  let timer = 0;
  let touchStart: {x:number; y:number; anchor:HTMLAnchorElement} | null = null;
  let suppressClickUntil = 0;
  let lastTouchAt = 0;
  const clearTouch = () => { window.clearTimeout(timer); touchStart = null; };
  document.addEventListener('pointerdown', event => {
    clearTouch();
    const anchor = anchorFromEvent(event);
    if (!isAndroidPwa() || event.pointerType !== 'touch' || !anchor || !linkURL(anchor)) return;
    lastTouchAt = Date.now();
    touchStart = { x:event.clientX, y:event.clientY, anchor };
    timer = window.setTimeout(() => {
      if (!touchStart || window.getSelection()?.toString()) return;
      const target = touchStart.anchor;
      const url = linkURL(target);
      if (url) {
        showActions(url, target);
        suppressClickUntil = Date.now() + 1200;
        // Chrome may retarget the release click to the sheet button now under
        // the finger. Consume that one synthesized click before it acts.
        suppressReleaseClick = true;
      }
      clearTouch();
    }, 550);
  }, true);
  document.addEventListener('pointermove', event => {
    if (touchStart && Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 12) clearTouch();
  }, true);
  document.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch' && suppressReleaseClick) {
      // The synthetic click from this finger release follows pointerup almost
      // immediately. Keep the guard short so the next intentional tap works.
      suppressTouchClickUntil = Date.now() + 180;
      suppressReleaseClick = false;
    }
    clearTouch();
  }, true);
  document.addEventListener('pointercancel', () => { suppressReleaseClick = false; clearTouch(); }, true);
  document.addEventListener('click', event => {
    if (Date.now() < suppressTouchClickUntil) {
      suppressTouchClickUntil = 0;
      event.preventDefault(); event.stopImmediatePropagation();
      return;
    }
    const anchor = anchorFromEvent(event);
    if (!anchor) return;
    const url = linkURL(anchor);
    if (!url) return;
    if (Date.now() < suppressClickUntil || (isAndroidPwa() && externalLinkPreference() === 'ask' && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)) {
      event.preventDefault(); event.stopPropagation();
      if (Date.now() >= suppressClickUntil) showActions(url, anchor);
    }
  }, true);
  document.addEventListener('contextmenu', event => {
    if (!isAndroidPwa()) return;
    const anchor = anchorFromEvent(event);
    const url = anchor && linkURL(anchor);
    if (!url) return;
    event.preventDefault();
    showActions(url, anchor);
    suppressClickUntil = Date.now() + 1200;
    if (Date.now() - lastTouchAt < 1200) suppressReleaseClick = true;
  }, true);
  document.addEventListener('keydown', event => {
    if (!isAndroidPwa()) return;
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    const anchor = anchorFromEvent(event);
    const url = anchor && linkURL(anchor);
    if (!url) return;
    event.preventDefault();
    showActions(url, anchor);
  }, true);
}

declare global { interface HTMLElementTagNameMap { 'mux-external-link-actions': ExternalLinkActions } }
