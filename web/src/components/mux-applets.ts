/**
 * mux-applets.ts -- Mission Control's applet HOST.
 *
 * The right-hand region of <mux-cos> used to be one thing: the fleet. It is
 * now a strip of tabs over a stack of APPLETS, each a custom element plus a
 * manifest (see lib/applet-registry.ts, which is the contract).
 *
 * TWO RULES CARRY THE WHOLE DESIGN, and both are here rather than in the
 * applets on purpose:
 *
 *   1. EVERY registered applet is MOUNTED, all the time. Switching tabs
 *      toggles visibility and nothing else, so scroll position, an open
 *      disclosure and a half-typed filter all survive a trip to another tab
 *      and back. A host that unmounted would be simpler and would throw all
 *      of that away on every click.
 *
 *   2. Because they stay mounted, the host tells each one whether it is
 *      `active`, and an INACTIVE APPLET MUST GO QUIET -- drop its
 *      subscriptions, its timers, its open connections. The host cannot do
 *      that for it; hiding a thing does not stop it working. This is the one
 *      obligation the contract puts on an applet, and the Dashboard applet's
 *      _sync() is the reference implementation.
 *
 * The RAIL -- the right-hand end of the tab strip -- is painted here from the
 * active manifest's `rail()`, which returns lit-html rendered into THIS
 * shadow root with THESE styles in scope. An applet fills the rail; it does
 * not get to restyle it. That is why three applets cannot make one strip look
 * like three products.
 *
 * Tokens are never re-declared here. --chrome-*, --ink-*, --edge, --surface
 * and the --r/--s/--t scales all inherit into this shadow root from
 * <mux-cos>'s :host and the document root (theme.ts:349), which is the entire
 * argument for applets being Lit elements in the first place.
 */

import { LitElement, html, css, nothing, type CSSResult, type TemplateResult } from 'lit';
import { html as staticHtml, unsafeStatic } from 'lit/static-html.js';
import { customElement, property, state } from 'lit/decorators.js';
import { icon } from '../lib/icons.js';
import {
  appletById,
  applets,
  type AppletElement,
  type AppletId,
  type AppletManifest,
  type AppletNavigateDetail,
} from '../lib/applet-registry.js';

// The built-ins, imported for their registerApplet() side effect. The host
// knows nothing else about them -- no import of their classes, no switch on
// their ids.
import './applets/applet-dashboard.js';
import './applets/applet-files.js';
import './applets/applet-prs.js';

/**
 * Which tab is showing. localStorage rather than the server config, for
 * mux-home's VIEW_KEY reason verbatim: a per-eyeball display preference with
 * no server-side meaning, which config.toml would make machine-wide.
 */
const TAB_KEY = 'muxterm.applet.host.tab';

function loadTab(): AppletId {
  try {
    const stored = localStorage.getItem(TAB_KEY);
    // Validated against the REGISTRY, not against a hand-written union: a key
    // left behind by an applet that no longer exists must not select nothing.
    if (stored && appletById(stored)) return stored as AppletId;
  } catch {
    /* private mode / storage disabled: still usable, just not sticky */
  }
  return 'dashboard';
}

function saveTab(id: AppletId): void {
  try {
    localStorage.setItem(TAB_KEY, id);
  } catch {
    /* not sticky; not fatal */
  }
}

/**
 * THE ONE empty/error presentation, exported so three applets do not invent
 * three idioms for "there is nothing here" and "that did not work".
 *
 * The templates render inside the APPLET's shadow root, where these styles
 * are not in scope, so an applet that uses them includes `appletStateStyles`
 * in its own static styles. That is the price of shadow encapsulation and it
 * is cheaper than the alternative.
 */
export const appletStateStyles: CSSResult = css`
  .applet-state {
    max-width: 34ch;
    margin: var(--s-7) auto;
    text-align: center;
    font-size: 13px;
    line-height: var(--lh-body);
    color: var(--ink-3);
  }
  .applet-state .retry {
    font: inherit;
    font-size: inherit;
    color: var(--chrome-accent);
    background: transparent;
    border: 0;
    padding: var(--s-2) 0 0;
    cursor: pointer;
    text-decoration: underline;
  }
`;

/** Nothing to show, and that is not a fault. */
export function appletEmpty(message: string): TemplateResult {
  return html`<div class="applet-state">${message}</div>`;
}

/** Something went wrong. One line, and a way to ask again when there is one. */
export function appletError(message: string, retry?: () => void): TemplateResult {
  return html`
    <div class="applet-state" role="alert">
      <div>${message}</div>
      ${retry
        ? html`<button class="retry" type="button" @click="${retry}">try again</button>`
        : nothing}
    </div>
  `;
}

@customElement('mux-applets')
export class MuxApplets extends LitElement {
  /**
   * Portrait, handed down from <mux-cos> which had it handed down from the
   * app's own breakpoint. In portrait the whole region is `display: none` and
   * the fleet lives in the bottom sheet, so every applet here is inactive.
   */
  @property({ type: Boolean, reflect: true }) narrow = false;

  /** The selected tab. Persisted; falls back to the Dashboard. */
  @state() private _current: AppletId = loadTab();

  /**
   * A navigation target waiting for its applet element to exist. Applied in
   * updated() rather than in show(), because show() may be the call that
   * mounts the applet in the first place -- and because assigning the
   * property directly sidesteps lit's dirty check, so navigating to the SAME
   * target twice in a row still lands.
   */
  private _pending: { id: AppletId; target: string } | null = null;

  static styles = css`
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    :host {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background: var(--chrome-bar);
    }
    :host([narrow]) {
      display: none;
    }

    /* The icon() helper emits this class; the rule is per-shadow-root. */
    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
      pointer-events: none;
    }

    /* -- THE STRIP -------------------------------------------------------
       Compact, and it does NOT scroll away: the applet body owns its own
       scroller so the tabs stay reachable however long a list gets. */
    .strip {
      flex: none;
      display: flex;
      align-items: stretch;
      height: 34px;
      padding: 0 var(--s-4);
      background: var(--chrome-bar);
      border-bottom: 1px solid var(--edge);
    }
    .tabs {
      display: flex;
      align-items: stretch;
      min-width: 0;
    }
    .spacer {
      flex: 1;
      min-width: 0;
    }
    .rail {
      display: flex;
      align-items: center;
      gap: var(--s-3);
      flex: none;
    }

    .tab {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: var(--s-2);
      font: inherit;
      font-size: var(--t-ui);
      font-weight: 400;
      line-height: 1;
      color: var(--ink-3);
      background: transparent;
      border: 0;
      padding: 0 var(--s-5);
      cursor: pointer;
    }
    .tab:hover {
      color: var(--ink-1);
    }
    .tab.on {
      color: var(--ink-1);
    }
    /* A 2px underline sitting ON the strip's bottom border, so the selected
       tab reads as attached to the body below it. */
    .tab.on::after {
      content: '';
      position: absolute;
      inset: auto 0 -1px 0;
      height: 2px;
      background: var(--chrome-accent);
    }

    /* -- THE RAIL'S VOCABULARY -------------------------------------------
       mux-cos's topbar geometry, verbatim. An applet's rail() fills these
       classes; it cannot introduce a control kind the host has no style for,
       and that is the deal (applet-registry.ts:60-66). */
    .seg {
      display: flex;
      gap: 2px;
      background: var(--surface);
      padding: 2px;
      border-radius: var(--r-ctl);
      border: 1px solid var(--edge);
      flex: none;
    }
    .seg button {
      display: inline-flex;
      align-items: center;
      gap: var(--s-2);
      font: inherit;
      font-size: 10.5px;
      font-weight: 600;
      line-height: 1;
      color: var(--ink-3);
      background: transparent;
      border: 0;
      padding: 4px 8px;
      border-radius: 3px;
      cursor: pointer;
    }
    .seg button:hover {
      color: var(--ink-1);
    }
    .seg button.on {
      background: color-mix(in srgb, var(--chrome-accent) 22%, var(--surface));
      color: var(--ink-1);
    }
    .toggle {
      font: inherit;
      font-size: 10.5px;
      font-weight: 600;
      line-height: 1;
      color: var(--ink-3);
      background: transparent;
      border: 1px solid var(--edge);
      border-radius: var(--r-ctl);
      padding: 5px 8px;
      cursor: pointer;
      flex: none;
    }
    .toggle:hover,
    .toggle.on {
      color: var(--ink-1);
      background: var(--chrome-hover);
    }

    .seg button:focus-visible,
    .toggle:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: 2px;
    }
    /* Inset, because a full-height tab has no room outside itself. */
    .tab:focus-visible {
      outline: 2px solid var(--chrome-accent);
      outline-offset: -2px;
    }

    /* -- THE BODY ---------------------------------------------------------
       Every applet is mounted here for the life of the host. The inactive
       ones are display:none AND told active=false; see the file header. */
    .body {
      position: relative;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }
    .body > .app {
      display: none;
    }
    .body > .app.on {
      display: block;
      position: absolute;
      inset: 0;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('applet-rail-changed', this._onRailChanged);
    this.addEventListener('applet-navigate', this._onNavigate);
  }

  override disconnectedCallback(): void {
    this.removeEventListener('applet-rail-changed', this._onRailChanged);
    this.removeEventListener('applet-navigate', this._onNavigate);
    super.disconnectedCallback();
  }

  /**
   * The rail is read OFF the live applet element, which does not exist until
   * the first render has committed. One extra render, once, buys a rail that
   * is populated immediately instead of at the next interaction.
   *
   * Queued behind updateComplete rather than requested inline, so it is a NEW
   * update cycle and not a re-entrant one -- lit warns about the latter, and
   * the warning would be right.
   */
  override firstUpdated(): void {
    void this.updateComplete.then(() => {
      this.requestUpdate();
    });
  }

  override updated(): void {
    const pending = this._pending;
    if (!pending) return;
    this._pending = null;
    const m = appletById(pending.id);
    const el = m ? this._appletEl(m) : null;
    if (el) el.target = pending.target;
  }

  /** Point the host at an applet, optionally at something inside it. */
  show(id: AppletId, target?: string): void {
    if (!appletById(id)) return;
    this._current = id;
    saveTab(id);
    if (target !== undefined) this._pending = { id, target };
    this.requestUpdate();
  }

  private _appletEl(m: AppletManifest): AppletElement | null {
    return this.renderRoot.querySelector(m.element) as AppletElement | null;
  }

  private _onRailChanged = (): void => {
    // The rail reads the applet's state directly, so a change there is only
    // visible after the HOST re-renders.
    this.requestUpdate();
  };

  /**
   * Navigation, always from a user gesture and never from a data change: an
   * applet that yanked the tab strip because a poll returned something new
   * would be moving the surface out from under the person reading it.
   */
  private _onNavigate = (e: Event): void => {
    const detail = (e as CustomEvent<AppletNavigateDetail>).detail;
    if (!detail?.applet) return;
    this.show(detail.applet, detail.target);
  };

  /** Roving focus across the strip, so a tablist behaves like one. */
  private _onTabKey = (e: KeyboardEvent): void => {
    const list = applets();
    if (list.length === 0) return;
    let delta = 0;
    if (e.key === 'ArrowRight') delta = 1;
    else if (e.key === 'ArrowLeft') delta = -1;
    else return;
    e.preventDefault();
    const at = list.findIndex((m) => m.id === this._current);
    const next = list[(at + delta + list.length) % list.length];
    if (!next) return;
    this.show(next.id);
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLButtonElement>('.tab.on')?.focus();
    });
  };

  override render(): TemplateResult {
    const list = applets();
    const active = this.narrow ? undefined : appletById(this._current);
    return html`
      <div class="strip">
        <div class="tabs" role="tablist" aria-label="Applets" @keydown="${this._onTabKey}">
          ${list.map((m) => this._renderTab(m))}
        </div>
        <span class="spacer"></span>
        <div class="rail">${active?.rail ? this._renderRail(active) : nothing}</div>
      </div>
      <div class="body">${list.map((m) => this._renderApplet(m))}</div>
    `;
  }

  private _renderTab(m: AppletManifest): TemplateResult {
    const on = m.id === this._current;
    return html`
      <button
        type="button"
        role="tab"
        id="${`tab-${m.id}`}"
        class="${on ? 'tab on' : 'tab'}"
        aria-selected="${on ? 'true' : 'false'}"
        aria-controls="${`panel-${m.id}`}"
        tabindex="${on ? '0' : '-1'}"
        @click="${() => this.show(m.id)}"
      >${icon(m.icon, { size: 13 })} ${m.label}</button>
    `;
  }

  private _renderRail(m: AppletManifest): TemplateResult | typeof nothing {
    const el = this._appletEl(m);
    if (!el || !m.rail) return nothing;
    return m.rail(el);
  }

  /**
   * THE MOUNTING LOOP. One element per manifest, created once and kept, with
   * the three contract properties written on every update.
   *
   * lit's static-html is what lets a TAG NAME come out of data: the manifest
   * says `applet-dashboard` and the host never names a class. It is `unsafe`
   * only in the sense that the tag is not a compile-time constant -- the
   * strings come from the built-in registry, never from the network or the
   * URL.
   */
  private _renderApplet(m: AppletManifest): TemplateResult {
    const on = m.id === this._current && !this.narrow;
    const tag = unsafeStatic(m.element);
    return staticHtml`
      <${tag}
        role="tabpanel"
        id="${`panel-${m.id}`}"
        aria-labelledby="${`tab-${m.id}`}"
        class="${on ? 'app on' : 'app'}"
        .active="${on}"
        .narrow="${this.narrow}"
      ></${tag}>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-applets': MuxApplets;
  }
}
