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
 * THE STRIP CARRIES NOTHING APPLET-SPECIFIC. It answers one question --
 * WHICH APPLET AM I LOOKING AT -- and a filter answers a different one, "what
 * is this applet showing me", which is the applet's own business and lives in
 * the applet's own body. The contract is stated in full at the top of
 * lib/applet-registry.ts; the test it has to pass is that a new applet with
 * three filters is a zero-line change to this file.
 *
 * That is a REVERSAL. This host used to paint a `rail` at the right-hand end
 * of the strip from the active manifest, in a vocabulary (`.seg`, `.toggle`)
 * that lived here -- so an applet could only have a control the host already
 * had a class for, and every new control kind widened this file. Three
 * built-ins had already spent two classes. The junk drawer was structural, so
 * there is now no slot at all: see lib/applet-controls.ts for where the
 * consistency the rail was buying went instead.
 *
 * The ATTENTION POLICY is also the host's, because only the host knows what
 * you are looking at. An applet says "something here wants a human"; the host
 * decides whether that is a badge on a tab or a move of the whole surface,
 * and it decides it the same way every time. The rule and the reasoning are
 * on _onAttention.
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
  type AppletAttentionDetail,
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
 * How long the surface has to sit untouched before an applet is allowed to
 * move it. A minute and a half, and the number is a claim about the PERSON
 * rather than about the data -- the full reasoning is on _onAttention, which
 * is the only thing that reads it.
 */
const IDLE_MS = 90_000;

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
   * Applets with something waiting, and how many things. Never contains the
   * current tab -- looking at an applet is what clears its flag.
   *
   * REPLACED, never mutated: lit dirty-checks by identity, so a `set()` on the
   * live Map would change the strip and not repaint it.
   */
  @state() private _flags = new Map<AppletId, number>();

  /**
   * When this surface was last touched by a person. NOT reactive state, on
   * purpose: it changes on every keystroke, and a render per keystroke to
   * repaint nothing is a cost with no reader.
   */
  private _lastGesture = Date.now();

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

    /* -- THE FLAG ---------------------------------------------------------
       Something on a tab you are not looking at wants a human. A dot when it
       is one thing, the count when it is more.

       It does not blink, pulse or slide. An animation on the edge of vision
       pulls the eye off whatever the person is actually reading, which is the
       precise harm the attention policy exists to avoid -- a flag that steals
       attention is just a slower version of stealing the surface. */
    .flag {
      flex: none;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--need);
    }
    /* The same flag, counting. Geometry off, type on. */
    .flag.n {
      width: auto;
      height: auto;
      border-radius: 0;
      background: transparent;
      font-family: var(--mono);
      font-size: var(--t-meta);
      font-variant-numeric: tabular-nums;
      line-height: 1;
      color: var(--need);
    }

    /* THERE IS NO CONTROL VOCABULARY HERE. The rail's .seg and .toggle rules
       used to live at this spot, and every applet control the host had no
       class for was a change to this file. See the header. */

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
    this.addEventListener('applet-navigate', this._onNavigate);
    this.addEventListener('applet-attention', this._onAttention);
    // CAPTURE, on the host itself. Every applet body sits inside this element,
    // and pointer and keyboard events are composed, so catching them on the
    // way down is one pair of listeners for the whole region -- no applet has
    // to remember to report that it was touched.
    this.addEventListener('pointerdown', this._onGesture, { capture: true });
    this.addEventListener('keydown', this._onGesture, { capture: true });
  }

  override disconnectedCallback(): void {
    this.removeEventListener('applet-navigate', this._onNavigate);
    this.removeEventListener('applet-attention', this._onAttention);
    this.removeEventListener('pointerdown', this._onGesture, { capture: true });
    this.removeEventListener('keydown', this._onGesture, { capture: true });
    super.disconnectedCallback();
  }

  override updated(): void {
    const pending = this._pending;
    if (!pending) return;
    this._pending = null;
    const m = appletById(pending.id);
    const el = m ? this._appletEl(m) : null;
    if (el) el.target = pending.target;
  }

  /**
   * Point the host at an applet, optionally at something inside it.
   *
   * This is the "the user asked" arm of the attention policy: it switches
   * immediately and unconditionally, because everything that reaches it is a
   * gesture -- a tab click, an arrow key, or an `applet-navigate` that D3.4
   * only ever fires from a user gesture and never from a data change.
   */
  show(id: AppletId, target?: string): void {
    if (!appletById(id)) return;
    // A tab switch counts as touching this surface however it was caused --
    // including the promotion test below, which switches on your behalf. That
    // it counts its own jump is deliberate: the surface never yanks twice in
    // a row, so the second lane to block while you are away leaves a flag
    // rather than another move.
    this._lastGesture = Date.now();
    this._current = id;
    saveTab(id);
    // You have seen it, which is the whole of what a flag ever claimed.
    this._clearFlag(id);
    if (target !== undefined) this._pending = { id, target };
    this.requestUpdate();
  }

  private _appletEl(m: AppletManifest): AppletElement | null {
    return this.renderRoot.querySelector(m.element) as AppletElement | null;
  }

  /**
   * Navigation, always from a user gesture and never from a data change: an
   * applet that yanked the tab strip because a poll returned something new
   * would be moving the surface out from under the person reading it.
   *
   * This is the "the user asked" arm of the attention policy, and its
   * exemption from the promotion test below is the whole reason the two arms
   * are different events: `applet-navigate` is only ever fired from a gesture
   * (D3.4), so it never has to earn the right to move the surface.
   */
  private _onNavigate = (e: Event): void => {
    const detail = (e as CustomEvent<AppletNavigateDetail>).detail;
    if (!detail?.applet) return;
    this.show(detail.applet, detail.target);
  };

  /** A person touched this surface. The only thing that resets the clock. */
  private _onGesture = (): void => {
    this._lastGesture = Date.now();
  };

  /**
   * Something on another tab wants a human.
   *
   * THE PROMOTION TEST -- flag by default, take the wheel only when the
   * surface has been left alone. Two things and only two things move it: the
   * user asking (show/_onNavigate above), and this.
   *
   * URGENCY IS NOT AN INPUT, and cannot be made into one. The event carries no
   * severity to consult -- see AppletAttentionDetail, which has no such field
   * on purpose -- so a caller convinced its news is important has nothing to
   * argue up with. Urgency alone never promotes a flag to a jump.
   *
   * The threshold is a claim about the PERSON, not about the data. Someone who
   * has not touched this surface in a minute and a half is not reading it, and
   * moving it costs them nothing. Someone who touched it four seconds ago IS
   * reading it, and moving it costs them their place -- the paragraph they
   * were halfway through, the row they were about to click. Stealing the
   * surface from a reader is worse than a badge they notice thirty seconds
   * late, every time, so the tie always goes to the flag.
   */
  private _onAttention = (e: Event): void => {
    const detail = (e as CustomEvent<AppletAttentionDetail>).detail;
    if (!detail?.applet || !appletById(detail.applet)) return;
    // You are already looking at it. There is nothing left to tell you, and a
    // flag on the tab you are on would be the surface talking to itself.
    if (detail.applet === this._current) return;

    if (Date.now() - this._lastGesture > IDLE_MS) {
      // Nobody is here. Take the wheel, and leave NO flag behind: the surface
      // moving is a louder announcement than a dot, and a dot on the tab you
      // now have open would only be something to dismiss.
      this.show(detail.applet);
      return;
    }

    // Somebody is here. Flag it and do not move.
    const raw = detail.count ?? 1;
    // A count that is not a whole number of things is a caller bug, not a
    // state to draw: a flag reading "0 needing attention" is worse than none.
    const count = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
    // WHOLE-STATE, IDEMPOTENT -- the count replaces whatever was there rather
    // than adding to it, the same contract the fleet's session snapshots use.
    // Two reports of "three lanes want you" mean three, not six.
    const next = new Map(this._flags);
    next.set(detail.applet, count);
    this._flags = next;
  };

  private _clearFlag(id: AppletId): void {
    if (!this._flags.has(id)) return;
    const next = new Map(this._flags);
    next.delete(id);
    this._flags = next;
  }

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
    return html`
      <div class="strip">
        <div class="tabs" role="tablist" aria-label="Applets" @keydown="${this._onTabKey}">
          ${list.map((m) => this._renderTab(m))}
        </div>
      </div>
      <div class="body">${list.map((m) => this._renderApplet(m))}</div>
    `;
  }

  private _renderTab(m: AppletManifest): TemplateResult {
    const on = m.id === this._current;
    const flag = this._flags.get(m.id) ?? 0;
    return html`
      <button
        type="button"
        role="tab"
        id="${`tab-${m.id}`}"
        class="${on ? 'tab on' : 'tab'}"
        aria-selected="${on ? 'true' : 'false'}"
        aria-controls="${`panel-${m.id}`}"
        aria-label="${flag > 0 ? `${m.label}, ${flag} needing attention` : nothing}"
        tabindex="${on ? '0' : '-1'}"
        @click="${() => this.show(m.id)}"
      >${icon(m.icon, { size: 13 })} ${m.label}${this._renderFlag(flag)}</button>
    `;
  }

  /**
   * The flag on a tab. A dot at one, the number above one -- "1" beside a
   * label is noise, and the dot already says the only thing one waiting thing
   * has to say.
   *
   * aria-hidden, because the tab's aria-label carries the same fact in words.
   * Without it a screen reader announces the count twice, once as a number
   * with no noun attached.
   */
  private _renderFlag(count: number): TemplateResult | typeof nothing {
    if (count <= 0) return nothing;
    if (count === 1) return html`<span class="flag" aria-hidden="true"></span>`;
    return html`<span class="flag n" aria-hidden="true">${count}</span>`;
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
