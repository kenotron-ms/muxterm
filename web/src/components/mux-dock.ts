import { LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { IDockviewPanel, IContentRenderer, SerializedDockview, DockviewGroupPanel } from 'dockview-core';
import type { MuxBrowserSurface } from './browser-surface.js';
import { DockviewComponent } from 'dockview-core';
import dockviewCss from 'dockview-core/dist/styles/dockview.css?inline';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import { terminalRegistry } from '../lib/terminal-registry.js';
import { muxLog } from '../lib/mux-log.js';
import type { SessiondPaneInfo } from '../types.js';
import { store } from '../state.js';

// ─────────────────────────────────────────────────────────────────────────────
// TerminalRenderer
// Bridges the dockview panel lifecycle to terminalRegistry.
// ─────────────────────────────────────────────────────────────────────────────

class TerminalRenderer implements IContentRenderer {
  readonly element: HTMLElement;
  private readonly _paneId: number;
  private readonly _isActivePane: (paneId: number) => boolean;
  private _attached = false;

  constructor(id: string, isActivePane: (paneId: number) => boolean) {
    this._paneId = parseInt(id, 10);
    this._isActivePane = isActivePane;
    const el = document.createElement('div');
    el.style.cssText = 'width:100%;height:100%;overflow:hidden;';

    // Isolate xterm's pointer events from dockview's panel drag-and-drop.
    //
    // dockview's ContentContainer wraps every panel in `.dv-content-container`
    // and attaches a pointer-backend drop target to it. That drop target calls
    // event.preventDefault() on pointerdown to drive panel DnD. Because this
    // element lives INSIDE `.dv-content-container`, a pointerdown that begins a
    // text-selection drag bubbles up and gets preventDefault()'d — which kills
    // xterm.js's own mouse-based selection (xterm sets `user-select: none` on
    // itself and implements selection via its SelectionService, not native
    // selection). The old `<mux-pane>` was immune because its terminal lived in
    // a shadow root; light DOM removed that boundary.
    //
    // stopPropagation() keeps these events from reaching dockview's drop target
    // while leaving xterm's listeners (on descendants) fully functional. Panel
    // focus uses focus/blur events, not pointer events, so it is unaffected.
    const swallow = (e: Event): void => e.stopPropagation();
    el.addEventListener('pointerdown', swallow);
    el.addEventListener('pointermove', swallow);
    el.addEventListener('pointerup', swallow);

    this.element = el;
  }

  init(): void {
    // Do NOT attach here. Dockview calls init() before the panel has final
    // layout dimensions. Attaching here (even via rAF) causes the terminal
    // to open at wrong cols/rows, making the PTY replay garbled ($$$$~~~~~).
    // Attachment is deferred to the first layout() call (element connected +
    // has real dimensions) via terminalRegistry.setContainer().
    muxLog('renderer init', `pane=${this._paneId}`, {
      hasTerminal: terminalRegistry.getTerminal(this._paneId) !== null,
    });
  }

  layout(): void {
    if (!this._attached) {
      muxLog('renderer layout', `pane=${this._paneId} not-yet-attached`,
        { isConnected: this.element.isConnected,
          w: this.element.offsetWidth, h: this.element.offsetHeight,
          isActive: this._isActivePane(this._paneId) });

      if (!this.element.isConnected) {
        // Panel not in DOM yet — retry next frame (dockview only calls layout()
        // on the active panel after DOM append; inactive panels get one
        // isConnected=false call and nothing after).
        requestAnimationFrame(() => this.layout());
        return;
      }

      // Element is connected. Hand off to the registry's independent lifecycle:
      // setContainer() either calls attach() immediately (if ensure() already
      // ran) or stores the container for attach() to be called when ensure()
      // runs later. Either way the terminal opens without depending on a
      // specific render-cycle ordering.
      this._attached = true;
      terminalRegistry.setContainer(this._paneId, this.element, this._isActivePane(this._paneId));
      return;
    }
    terminalRegistry.fitIfVisible(this._paneId);
  }

  focus(): void {
    terminalRegistry.focus(this._paneId);
  }

  dispose(): void {
    // Does NOT destroy the terminal — PTY stays alive, scrollback preserved.
    terminalRegistry.detach(this._paneId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BrowserRenderer
// Bridges the dockview panel lifecycle to a mux-browser-surface element.
// ─────────────────────────────────────────────────────────────────────────────

class BrowserRenderer implements IContentRenderer {
  readonly element: HTMLElement;
  private readonly _paneId: number;
  private readonly _port: number;
  private readonly _path: string;
  private _surface: MuxBrowserSurface | null = null;

  constructor(id: string, pane: SessiondPaneInfo) {
    this._paneId = parseInt(id, 10);
    this._port = pane.browserPort ?? 0;
    this._path = pane.browserPath ?? '/';
    const el = document.createElement('div');
    el.style.cssText = 'width:100%;height:100%;overflow:hidden;';
    this.element = el;
  }

  init(): void {
    const proxyUrl = `${location.origin}/p/${this._port}${this._path}`;
    const surface = document.createElement('mux-browser-surface') as MuxBrowserSurface;
    surface.url = proxyUrl;
    this.element.appendChild(surface);
    this._surface = surface;

    this.element.addEventListener('url-change', (e: Event) => {
      const { url } = (e as CustomEvent<{ url: string }>).detail;
      try {
        const parsed = new URL(url);
        const prefix = `/p/${this._port}`;
        const browserPath = parsed.pathname.startsWith(prefix)
          ? parsed.pathname.slice(prefix.length) || '/'
          : parsed.pathname;
        this.element.dispatchEvent(
          new CustomEvent('pane-navigate', {
            bubbles: true,
            composed: true,
            detail: { paneId: this._paneId, browserPath },
          }),
        );
      } catch {
        // silently ignore malformed URLs
      }
    });
  }

  layout(): void {
    // no-op
  }

  focus(): void {
    const input = this._surface?.shadowRoot?.querySelector<HTMLInputElement>('.address');
    input?.focus();
  }

  dispose(): void {
    this._surface?.remove();
    this._surface = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HeaderButton
// A single icon button used as a dockview header action. Two are mounted per
// group, in different dockview header slots:
//   [+]    — left action slot (renders right after the tabs): new pane as a TAB
//   [split] — right action slot (far right): split into a side-by-side group
// ─────────────────────────────────────────────────────────────────────────────

const ADD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none">
  <path d="M8 3.25v9.5M3.25 8h9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

// VS Code-style split icon: two side-by-side rectangles.
const SPLIT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none">
  <rect x="1" y="2" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/>
  <rect x="9" y="2" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/>
</svg>`;

// Browser/globe icon: circle with horizontal latitude lines and a center longitude ellipse.
const BROWSER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none">
  <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/>
  <ellipse cx="8" cy="8" rx="2.5" ry="6" stroke="currentColor" stroke-width="1.3"/>
  <path d="M2.5 5.5h11M2.5 10.5h11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
</svg>`;

class HeaderButton {
  readonly element: HTMLElement;

  constructor(icon: string, title: string, onClick: () => void) {
    const btn = document.createElement('button');
    btn.className = 'mux-header-btn';
    btn.title = title;
    btn.innerHTML = icon;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    this.element = btn;
  }

  init(): void { /* nothing to initialise */ }
  dispose(): void { this.element.remove(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MuxDock
// ─────────────────────────────────────────────────────────────────────────────

/** Unique ID for the injected mux-dock style tag; prevents double-inject. */
const STYLE_ID = 'mux-dock-styles';

@customElement('mux-dock')
export class MuxDock extends LitElement {
  // Light DOM is REQUIRED for dockview DnD to work.
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) panes: SessiondPaneInfo[] = [];
  @property({ attribute: false }) activePaneId = -1;
  @property({ attribute: false }) workspaceKey = '';
  @property({ attribute: false }) layout = '';
  /**
   * Narrow (phone) mode: a tab view only. No split button, no saved/restored
   * layout — all panes collapse into a single dockview group as tabs. Wide
   * (tablet + PC) gets the full split layout with save/restore.
   */
  @property({ attribute: false, type: Boolean }) narrow = false;

  private _dv: DockviewComponent | null = null;
  private _panels = new Map<number, IDockviewPanel>();
  private _settingActive = false;
  private _browserPopoverOpen = false;
  private _browserPopoverGroup: DockviewGroupPanel | null = null;
  /** User-defined pane names — persists across workspace switches for the session. */
  private _customTitles = new Map<number, string>();
  /**
   * Pane IDs closed by the user via the dockview tab X button.
   * These are excluded from reconciler re-adds (Case 2) until the
   * workspace changes (Case 1 clears this set).
   */
  private _locallyClosedPanes = new Set<number>();
  /** Pointer type that initiated the most recent interaction ('mouse' | 'touch' | 'pen').
   *  Read in onDidRemovePanel to decide whether a close should be deferred.
   *  NOTE: best-effort — if two tabs are closed within a single animation frame,
   *  the second pointerdown overwrites this before the first onDidRemovePanel fires.
   *  Currently harmless (all close types share the same grace duration). Revisit
   *  with a per-tab WeakMap if per-input-type durations are ever added.
   */
  private _lastPointerType: string = 'mouse';
  /** Bound capture-phase handler so we can remove it in disconnectedCallback. */
  private _onPointerDownCapture = (e: PointerEvent): void => {
    this._lastPointerType = e.pointerType || 'mouse';
  };
  /** True while we're programmatically removing panels to suppress pane-close events. */
  private _removingPanels = false;
  /** Debounce timer for layout-save events. */
  private _layoutSaveTimer: number | undefined;
  /** True while restoring a layout via fromJSON — suppresses layout-save echoes. */
  private _restoringLayout = false;
  /**
   * Where the NEXT newly-added pane should be placed:
   *   'tab'   — a new tab in the active group (the "+" button)
   *   'split' — a new side-by-side group split off the active panel (the
   *             "split" button)
   * The reconciler reads this when the real (server-assigned) pane arrives,
   * then resets it to the 'tab' default.
   */
  private _nextPlacement: 'tab' | 'split' = 'tab';
  /** ID of the panel to split from when _nextPlacement === 'split'. */
  private _splitReferenceId: string | null = null;
  /**
   * ID of a panel in the group whose "+" / split button was clicked. The new
   * pane is placed relative to THIS group, so clicking "+" on an inactive
   * group adds the tab there (and activates it) — not in the active group.
   */
  private _placementReferenceId: string | null = null;

  /**
   * Record the desired placement and ask the app to create a backing pane.
   * `group` is the dockview group whose header button was clicked; the new
   * pane is positioned relative to it so the click target is honored.
   */
  private _requestPane(placement: 'tab' | 'split', group?: DockviewGroupPanel): void {
    this._nextPlacement = placement;
    // Prefer the clicked group's active panel as the reference; fall back to
    // the globally active panel only if the group is unknown.
    this._placementReferenceId =
      group?.activePanel?.id ?? this._dv?.activePanel?.id ?? null;
    this._splitReferenceId = placement === 'split' ? this._placementReferenceId : null;
    this.dispatchEvent(new CustomEvent('pane-create', { bubbles: true, composed: true }));
  }

  /** Toggle the browser port popover open/closed for the given group. */
  private _toggleBrowserPopover(group: DockviewGroupPanel, triggerEl: HTMLElement): void {
    if (this._browserPopoverOpen) {
      this._closeBrowserPopover();
    } else {
      this._browserPopoverOpen = true;
      this._browserPopoverGroup = group;
      this._renderBrowserPopover(triggerEl);
    }
  }

  /** Close and remove the browser port popover, resetting state. */
  private _closeBrowserPopover(): void {
    this.querySelector('.mux-browser-popover')?.remove();
    this._browserPopoverOpen = false;
    this._browserPopoverGroup = null;
  }

  /** Render the browser port popover and append it to this element. */
  private _renderBrowserPopover(triggerEl: HTMLElement): void {
    // Remove any stale popover first.
    this.querySelector('.mux-browser-popover')?.remove();

    const popover = document.createElement('div');
    popover.className = 'mux-browser-popover';

    // Anchor the popover directly below the trigger button using fixed positioning
    // so it appears regardless of where mux-dock sits in the DOM flow.
    const rect = triggerEl.getBoundingClientRect();
    popover.style.position = 'fixed';
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.right = `${window.innerWidth - rect.right}px`;

    const label = document.createElement('label');
    label.textContent = 'Port';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '65535';
    input.placeholder = '5173';

    const errorDiv = document.createElement('div');
    errorDiv.className = 'mux-browser-error';

    const openBtn = document.createElement('button');
    openBtn.className = 'mux-browser-open-btn';
    openBtn.textContent = 'Open';

    popover.appendChild(label);
    popover.appendChild(input);
    popover.appendChild(errorDiv);
    popover.appendChild(openBtn);
    this.appendChild(popover);

    // Autofocus the input.
    input.focus();

    const submit = (): void => {
      const portStr = input.value.trim();
      const port = parseInt(portStr, 10);
      if (!portStr || isNaN(port) || port < 1 || port > 65535) {
        errorDiv.textContent = 'Enter a port between 1 and 65535';
        return;
      }
      this._closeBrowserPopover();
      this.dispatchEvent(
        new CustomEvent('browser-pane-open', {
          bubbles: true,
          composed: true,
          detail: { browserPort: port },
        }),
      );
    };

    openBtn.addEventListener('click', submit);

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      // Prevent dockview from intercepting keystrokes in the popover.
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        this._closeBrowserPopover();
      }
    });

    // Click-outside dismissal: delay so the triggering click doesn't immediately close.
    setTimeout(() => {
      const onDocClick = (e: MouseEvent): void => {
        if (!popover.contains(e.target as Node)) {
          document.removeEventListener('click', onDocClick, true);
          this._closeBrowserPopover();
        }
      };
      document.addEventListener('click', onDocClick, true);
    }, 0);
  }

  /**
   * Extract the saved GLOBAL active pane id from the persisted layout JSON.
   * dockview's fromJSON restores each group's per-group activeView but does NOT
   * reliably re-activate the top-level activeGroup, so we read it ourselves:
   * find the grid leaf whose group id === activeGroup, and return that leaf's
   * activeView (the pane id). Returns undefined if the layout can't tell us.
   */
  private _activePaneIdFromSavedLayout(): string | undefined {
    try {
      const parsed = JSON.parse(this.layout) as SerializedDockview & { activeGroup?: string };
      const activeGroup = parsed.activeGroup;
      if (activeGroup === undefined) return undefined;
      // Walk the grid tree to find the leaf node whose data.id === activeGroup.
      let found: string | undefined;
      const visit = (node: { type?: string; data?: unknown }): void => {
        if (found !== undefined || !node) return;
        if (node.type === 'leaf') {
          const d = node.data as { id?: string; activeView?: string } | undefined;
          if (d?.id === activeGroup) found = d.activeView;
          return;
        }
        const children = (node.data as { type?: string }[] | undefined) ?? [];
        for (const child of children) visit(child as { type?: string; data?: unknown });
      };
      visit(parsed.grid?.root as { type?: string; data?: unknown });
      return found;
    } catch {
      return undefined;
    }
  }

  private _scheduleLayoutSave(): void {
    if (this.narrow) return; // narrow (phone) is a tab view — no persisted layout
    if (this._restoringLayout) return; // don't echo a save while we're restoring
    if (this._layoutSaveTimer !== undefined) clearTimeout(this._layoutSaveTimer);
    this._layoutSaveTimer = window.setTimeout(() => {
      if (!this._dv) return;
      const json = JSON.stringify(this._dv.toJSON());
      this.dispatchEvent(new CustomEvent('layout-save', { detail: { layout: json }, bubbles: true, composed: true }));
    }, 400);
  }

  private _refreshBellTitles(): void {
    for (const [paneId, panel] of this._panels) {
      const rawTitle =
        this._customTitles.get(paneId) ??
        this.panes.find((p) => p.paneId === paneId)?.title ??
        `Pane ${paneId}`;
      const tabEl = (panel as unknown as { view?: { tab?: { element?: HTMLElement } } })
        .view?.tab?.element?.querySelector<HTMLElement>('.dv-default-tab-content');
      if (!tabEl) continue;
      tabEl.textContent = '';
      if (store.paneBellActive(paneId)) {
        const bell = document.createElement('span');
        bell.className = 'mux-bell-prefix';
        bell.textContent = '● ';
        tabEl.appendChild(bell);
      }
      tabEl.appendChild(document.createTextNode(rawTitle));
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();

    // mux-dock is a light-DOM element but lives inside mux-app's ShadowRoot.
    // All styles must be injected into that ShadowRoot — document.head styles
    // cannot pierce a shadow boundary.
    const root = this.getRootNode();
    const target = root instanceof ShadowRoot ? root : document.head;

    // Inject xterm.js's stylesheet into the SAME root as dockview's CSS, here at
    // connect time. This is deterministic: mux-dock reliably lives inside
    // mux-app's ShadowRoot, so this.getRootNode() resolves to that ShadowRoot
    // and the stylesheet is present BEFORE any terminal attaches.
    //
    // Doing it here (rather than lazily per-terminal at attach time via the
    // container's getRootNode) avoids a race: during dockview's fromJSON layout
    // restore, a panel's element can attach while still in a detached subtree,
    // so its getRootNode() returns a document fragment and xterm.css lands in
    // document.head — which cannot pierce the shadow boundary, leaving xterm's
    // measurement elements unstyled and leaking as $$$$~~~~. Injecting once,
    // early, into the shadow root sidesteps the timing entirely.
    const XTERM_BASE_ID = 'xterm-base-css';
    if (!target.querySelector(`#${XTERM_BASE_ID}`)) {
      const xt = document.createElement('style');
      xt.id = XTERM_BASE_ID;
      xt.textContent = xtermCss;
      target.appendChild(xt);
    }

    // Inject dockview's full CSS (base layout + all themes) into the shadow root.
    // Must live here so dockview's theme class selectors can reach panel elements.
    const BASE_ID = 'dockview-base-css';
    if (!target.querySelector(`#${BASE_ID}`)) {
      const base = document.createElement('style');
      base.id = BASE_ID;
      base.textContent = dockviewCss;
      target.appendChild(base);
    }

    // Base = dockview's built-in "abyss" theme (for its flat STRUCTURE only:
    // zero tab radius/margin, transparent sashes). We re-skin all of its COLORS
    // to Tokyo Night below so the tab bar matches muxterm's title bar and
    // follows VS Code's tab hierarchy:
    //   • active tab background == terminal body (#1a1b26) → tab "merges" into
    //     the content, the VS Code selected-tab look,
    //   • tab bar + inactive tabs share the title bar surface (#16161e) with
    //     dimmer text, so unselected tabs recede,
    //   • the active tab carries a blue top accent border as the selection cue.
    if (!target.querySelector(`#${STYLE_ID}`)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        mux-dock {
          display: block;
          flex: 1;
          width: 100%;
          height: 100%;
        }

        /* Tokyo Night re-skin of dockview (over the abyss base). Variables set
           on .dv-dockview override the abyss palette via inheritance. */
        mux-dock .dv-dockview {
          --dv-background-color: #1a1b26;

          /* Panel CONTENT background. Must equal the terminal background so the
             few sub-character pixels left when xterm can't fill the pane to an
             exact row height don't bleed a contrasting color. */
          --dv-group-view-background-color: #1a1b26;

          /* Tab bar surface — same as the title bar (#16161e) so the chrome
             reads as one continuous dark band. */
          --dv-tabs-and-actions-container-background-color: #16161e;

          /* Active group: selected tab merges into the body, others blend into
             the bar. */
          --dv-activegroup-visiblepanel-tab-background-color: #1a1b26;
          --dv-activegroup-hiddenpanel-tab-background-color: #16161e;
          /* Inactive group (unfocused split): same hierarchy, no extra dimming
             of the surfaces — only the text dims. */
          --dv-inactivegroup-visiblepanel-tab-background-color: #1a1b26;
          --dv-inactivegroup-hiddenpanel-tab-background-color: #16161e;

          /* Text: selected bright, unselected dim. */
          --dv-activegroup-visiblepanel-tab-color: #c0caf5;
          --dv-activegroup-hiddenpanel-tab-color: #565f89;
          --dv-inactivegroup-visiblepanel-tab-color: #a9b1d6;
          --dv-inactivegroup-hiddenpanel-tab-color: #565f89;

          /* Hairline separators kept subtle. */
          --dv-separator-border: #292e42;
          --dv-tab-divider-color: #16161e;

          /* Resize sash: invisible track, accent only while dragging. */
          --dv-sash-color: transparent;
          --dv-active-sash-color: #7aa2f7;
        }

        /* Chrome-like tab sizing.
           Dockview DOM order: [scrollable+tabs] [left-actions (+)] [void] [right-actions (split)]
           The void has flex-grow:1 by default — it fills the gap so split lands far right.
           The problem was tabs had flex-shrink:1 so they compressed into whatever space the
           void left. Fix: tabs get flex-shrink:0 so they stay 180px. When many tabs overflow
           the scrollable, Dockview's horizontal scroll handles it. Void stays at default
           flex-grow:1 — no override needed. */

        /* Tabs stay at 180px — no grow, no shrink */
        mux-dock .dv-tab {
          border-top: 2px solid transparent;
          flex-grow: 0 !important;   /* beats dv-single-tab full-width rule */
          flex-shrink: 0 !important; /* beats dv-tab { flex-shrink:0 } default; no compression */
          flex-basis: var(--mux-tab-max-width, 180px);
          padding: 0.25rem 0.5rem !important; /* restored — dv-single-tab zeros it */
          min-width: var(--mux-tab-min-width, 80px);
          max-width: var(--mux-tab-max-width, 180px);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        mux-dock .dv-tab.dv-active-tab {
          border-top: 2px solid #7aa2f7 !important;
        }

        /* Close button — show on hover + always on active tab */
        mux-dock .dv-tab .dv-default-tab-action {
          opacity: 0;
          transition: opacity 0.15s;
        }
        mux-dock .dv-tab .dv-default-tab-action svg {
          fill: #a9b1d6;
        }
        mux-dock .dv-tab:hover .dv-default-tab-action,
        mux-dock .dv-tab.dv-active-tab .dv-default-tab-action {
          opacity: 1;
        }

        /* Header action icon buttons ("+" after the tabs, split far right) */
        mux-dock .mux-header-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          align-self: center;
          width: 28px;
          height: 28px;
          margin: 0 4px;
          padding: 0;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: #a9b1d6;
          cursor: pointer;
          flex-shrink: 0;
          transition: background 0.12s, color 0.12s;
        }
        mux-dock .mux-header-btn:hover {
          background: rgba(122, 162, 247, 0.15);
          color: #c0caf5;
        }
        mux-dock .mux-header-btn:active {
          background: rgba(122, 162, 247, 0.25);
        }

        /* dockview's action containers shrink-wrap their button and sit at the
           header's top edge, so the 28px button is top-pinned in the 35px bar.
           Make the containers full-height and center their content so the
           "+" / split buttons line up with the vertical middle of the tabs. */
        mux-dock .dv-left-actions-container,
        mux-dock .dv-right-actions-container {
          display: flex;
          align-items: center;
          height: 100%;
        }

        /* Inline tab rename input */
        mux-dock .mux-tab-rename-input {
          background: #24283b;
          color: #c0caf5;
          border: 1px solid #7aa2f7;
          border-radius: 3px;
          padding: 0 4px;
          font: inherit;
          font-size: inherit;
          outline: none;
          width: 100px;
          min-width: 60px;
          max-width: 160px;
        }

        /* Bell dot prefix on pane tabs */
        mux-dock .mux-bell-prefix {
          color: var(--mux-bell, #e0af68);
          font-style: normal;
        }

        /* Mobile: hide tab bar on narrow viewports */
        @media (max-width: 768px) {
          mux-dock .dv-tabs-and-actions-container {
            display: none !important;
          }
        }

        /* Browser port popover */
        mux-dock .mux-browser-popover {
          z-index: 200;
          background: #1a1b26;
          border: 1px solid #292e42;
          border-radius: 6px;
          display: flex;
          flex-direction: column;
          padding: 12px;
          gap: 8px;
          min-width: 180px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        }
        mux-dock .mux-browser-popover label {
          color: #a9b1d6;
          font-size: 0.75rem;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        mux-dock .mux-browser-popover input[type='number'] {
          background: #24283b;
          color: #c0caf5;
          border: 1px solid #414868;
          border-radius: 4px;
          padding: 4px 8px;
          font: inherit;
          font-size: 0.875rem;
          outline: none;
          width: 100%;
          box-sizing: border-box;
        }
        mux-dock .mux-browser-popover input[type='number']:focus {
          border-color: #7aa2f7;
        }
        /* Hide spin buttons */
        mux-dock .mux-browser-popover input[type='number']::-webkit-inner-spin-button,
        mux-dock .mux-browser-popover input[type='number']::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        mux-dock .mux-browser-popover input[type='number'] {
          -moz-appearance: textfield;
          appearance: textfield;
        }
        mux-dock .mux-browser-open-btn {
          background: #3d59a1;
          color: #c0caf5;
          border: none;
          border-radius: 4px;
          padding: 5px 10px;
          font: inherit;
          font-size: 0.875rem;
          cursor: pointer;
          transition: background 0.12s;
        }
        mux-dock .mux-browser-open-btn:hover {
          background: #7aa2f7;
          color: #1a1b26;
        }
        mux-dock .mux-browser-error {
          color: #f7768e;
          font-size: 0.75rem;
          min-height: 1em;
        }
      `;
      target.appendChild(style);
    }

    // Record the pointer type that starts each interaction. The capture phase
    // guarantees we see it before dockview processes the click and fires
    // onDidRemovePanel, so the close branch knows whether it was a touch/pen.
    this.addEventListener('pointerdown', this._onPointerDownCapture, { capture: true });
    this.classList.add('dockview-theme-abyss');
    this.addEventListener('dblclick', this._onTabDblClick);
    this._dv = new DockviewComponent(this, {
      createComponent: (opts) => {
        if (opts.name === 'browser') {
          const pane = this.panes.find((p) => p.paneId === parseInt(opts.id, 10));
          if (!pane) throw new Error(`No pane found for id ${opts.id}`);
          return new BrowserRenderer(opts.id, pane);
        }
        return new TerminalRenderer(opts.id, (paneId) => paneId === this.activePaneId);
      },
      // dockview header DOM order is: [tabs] [left-actions] [void] [right-actions].
      // The "left" slot therefore renders immediately after the tabs (before
      // the grow-to-fill void), and the "right" slot renders far right.
      //   "+"    → left slot  → sits just right of the tabs (new pane as a TAB)
      //   split  → right slot → far right (split into a side-by-side group)
      // The factory receives the dockview group its header belongs to, so the
      // "+" / split on an INACTIVE group still targets THAT group.
      createLeftHeaderActionComponent: (group) =>
        new HeaderButton(ADD_ICON, 'New pane', () => this._requestPane('tab', group)),
      // Narrow (phone) is a tab view only — no split button, no browser button.
      createRightHeaderActionComponent: (group) => {
        if (this.narrow) {
          return new HeaderButton('', '', () => {});
        }
        // Wide: [⌂] browser button + [⊠] split button in a flex row container.
        const container = document.createElement('div');
        container.style.cssText = 'display:flex;flex-direction:row;align-items:center;';
        const browserBtn = new HeaderButton(BROWSER_ICON, 'Open browser pane', () =>
          this._toggleBrowserPopover(group, browserBtn.element),
        );
        const splitBtn = new HeaderButton(SPLIT_ICON, 'Split pane', () =>
          this._requestPane('split', group),
        );
        container.appendChild(browserBtn.element);
        container.appendChild(splitBtn.element);
        return {
          element: container,
          init(): void { /* nothing to initialise */ },
          dispose(): void {
            browserBtn.dispose();
            splitBtn.dispose();
            container.remove();
          },
        };
      },
    });
    this._dv.onDidLayoutChange(() => this._scheduleLayoutSave());
    this._dv.onDidActivePanelChange((panel) => {
      if (this._settingActive) return;
      if (!panel) return;
      const paneId = parseInt(panel.id, 10);
      store.ackPane(paneId); // clear bell indicator when tab is focused directly
      this.dispatchEvent(new CustomEvent('pane-select', { detail: { paneId }, bubbles: true, composed: true }));
      // Defer focus to next frame: calling term.focus() synchronously inside the
      // dockview tab-click handler fires BEFORE the browser finishes resolving
      // focus for the clicked tab element, so the browser steals it back. An rAF
      // defers until after the click event is fully processed.
      requestAnimationFrame(() => terminalRegistry.focus(paneId));
      // Persist the new active selection: onDidLayoutChange does NOT fire on a
      // pure active-tab switch, so without this the saved layout keeps a stale
      // activeView and the wrong pane is selected after a refresh.
      this._scheduleLayoutSave();
    });
    this._dv.onDidRemovePanel((panel) => {
      if (this._removingPanels) return;
      const paneId = parseInt(panel.id, 10);
      if (this._panels.has(paneId)) {
        // Capture the tab title BEFORE deleting the panel record — the toast
        // labels itself "<title> closed". Falls back to "Pane N".
        const title = panel.title ?? `Pane ${paneId}`;
        // touch is retained in the event detail for observability and future use
        // (e.g. per-input-type grace period durations), even though _onClosePane
        // no longer branches on it.
        const touch = this._lastPointerType === 'touch' || this._lastPointerType === 'pen';
        this._panels.delete(paneId);
        this._locallyClosedPanes.add(paneId);
        this.dispatchEvent(
          new CustomEvent('pane-close', {
            detail: { paneId, touch, title },
            bubbles: true,
            composed: true,
          }),
        );
      }
      requestAnimationFrame(() => {
        if (this._dv) {
          this._dv.layout(this.offsetWidth, this.offsetHeight, true);
        }
      });
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('pointerdown', this._onPointerDownCapture, { capture: true });
    this._dv?.dispose();
    this._dv = null;
  }

  /** Handle double-click on a dockview default tab — starts inline rename. */
  private _onTabDblClick = (e: MouseEvent): void => {
    const tabContent = (e.target as Element).closest?.('.dv-default-tab-content') as HTMLElement | null;
    if (!tabContent) return;

    // Use the active panel for the pane ID. By the time dblclick fires, the
    // single-click has already activated this tab, so activePanel is correct.
    const activePanel = this._dv?.activePanel;
    if (!activePanel) return;

    const paneId = parseInt(activePanel.id, 10);
    const currentTitle = (tabContent.textContent ?? '').replace(/^● /, '');

    // Hide the tab text and insert an input in its place.
    tabContent.style.display = 'none';
    const input = document.createElement('input');
    input.className = 'mux-tab-rename-input';
    input.value = currentTitle;
    tabContent.parentElement?.insertBefore(input, tabContent.nextSibling);
    input.focus();
    input.select();

    const finish = (save: boolean): void => {
      const next = save ? (input.value.trim() || currentTitle) : currentTitle;
      input.remove();
      tabContent.style.display = '';
      tabContent.textContent = '';
      if (store.paneBellActive(paneId)) {
        const bell = document.createElement('span');
        bell.className = 'mux-bell-prefix';
        bell.textContent = '● ';
        tabContent.appendChild(bell);
      }
      tabContent.appendChild(document.createTextNode(next));
      if (save && next !== currentTitle) {
        this._customTitles.set(paneId, next);
        this.dispatchEvent(new CustomEvent('pane-rename', { detail: { paneId, name: next }, bubbles: true, composed: true }));
      }
    };

    input.addEventListener('blur', () => finish(true), { once: true });
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); // prevent dockview / xterm from seeing keystrokes
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') {
        // Remove the blur listener before removing the input
        input.replaceWith(input); // detach + reattach tricks the once listener off
        finish(false);
      }
    });
  };

  override updated(changed: Map<string, unknown>): void {
    if (!this._dv) return;

    // Case 1: workspaceKey changed → full panel reset
    if (changed.has('workspaceKey')) {
      this._closeBrowserPopover();
      muxLog('dock case1', `workspaceKey changed`,
        { workspaceKey: this.workspaceKey, panes: this.panes.map(p => p.paneId),
          activePaneId: this.activePaneId, hasLayout: !!this.layout });
      this._settingActive = true;
      this._removingPanels = true;
      try {
        // Clear locally-closed set: new workspace starts fresh.
        this._locallyClosedPanes.clear();
        // Close all existing panels
        for (const [, panel] of this._panels) {
          this._dv.removePanel(panel);
        }
        this._panels.clear();

        // Seed _customTitles from server-stored titles (arrive in composition panes).
        for (const pane of this.panes) {
          if (pane.title) this._customTitles.set(pane.paneId, pane.title);
        }

        // Try to restore the saved dockview layout (wide mode only). Narrow
        // (phone) is a tab view only: skip restore so all panes collapse into a
        // single dockview group as tabs.
        const alive = new Set(this.panes.filter((p) => p.paneId >= 0).map((p) => p.paneId));
        let restored = false;
        if (!this.narrow && this.layout) {
          try {
            this._restoringLayout = true;
            muxLog('dock restore', 'calling fromJSON', { layoutLength: this.layout.length });
            this._dv.fromJSON(JSON.parse(this.layout) as SerializedDockview);
            // Rebuild the panel map from whatever fromJSON recreated.
            this._panels.clear();
            for (const panel of this._dv.panels) {
              this._panels.set(parseInt(panel.id, 10), panel);
            }
            // Prune panels whose pane died while we were away.
            // (_removingPanels is already true from outer guard — no inner reset needed.)
            // Snapshot entries before iterating since we mutate _panels in the loop.
            for (const [paneId, panel] of Array.from(this._panels)) {
              if (!alive.has(paneId)) {
                this._dv.removePanel(panel);
                this._panels.delete(paneId);
              }
            }
            // Add any alive panes that weren't in the saved layout (created elsewhere).
            for (const pane of this.panes.filter((p) => p.paneId >= 0)) {
              if (!this._panels.has(pane.paneId)) {
                const panel = this._dv.addPanel({
                  id: String(pane.paneId),
                  component: pane.surfaceKind ?? 'terminal',
                  title: this._customTitles.get(pane.paneId) ?? pane.title ?? `Pane ${pane.paneId}`,
                });
                this._panels.set(pane.paneId, panel);
              }
            }
            restored = this._panels.size > 0;
            muxLog('dock restore', 'fromJSON complete', { panelCount: this._panels.size, restored });
          } catch (e) {
            // Corrupt/incompatible layout — fall back to a clean tab build.
            muxLog('dock restore', 'fromJSON FAILED — falling back', { err: String(e) });
            restored = false;
            this._panels.clear();
            this._dv.clear();
          } finally {
            this._restoringLayout = false;
          }
        }

        if (!restored) {
          // Existing behavior: add fresh panels for panes with valid paneId as tabs.
          for (const pane of this.panes.filter((p) => p.paneId >= 0)) {
            const panel = this._dv.addPanel({
              id: String(pane.paneId),
              component: pane.surfaceKind ?? 'terminal',
              title: this._customTitles.get(pane.paneId) ?? pane.title ?? `Pane ${pane.paneId}`,
            });
            this._panels.set(pane.paneId, panel);
          }
        }

        if (restored) {
          // dockview's fromJSON restores each group's per-group activeView, but
          // does NOT reliably re-activate the saved top-level activeGroup — it
          // reverts the GLOBAL active panel to the first group. So explicitly
          // re-activate the panel named by the saved layout's activeGroup +
          // that group's activeView. Fall back to dockview's own activePanel
          // only if the saved layout can't tell us.
          const _fromLayout = this._activePaneIdFromSavedLayout();
          const _fromDv = this._dv.activePanel?.id;
          muxLog('dock restore', 'active pane resolution',
            { fromLayout: _fromLayout, fromDockview: _fromDv, storeActivePaneId: this.activePaneId });
          const activePaneId = _fromLayout ?? _fromDv;
          if (activePaneId !== undefined) {
            const paneId = parseInt(String(activePaneId), 10);
            const panel = this._panels.get(paneId);
            muxLog('dock restore', `setActive pane=${paneId}`, { panelFound: !!panel });
            if (panel) {
              // setActive makes this panel's group the GLOBAL active group.
              panel.api.setActive();
            }
            // Do NOT force store's activePaneId (hard-coded to panes[0]) — sync
            // the store to the restored selection instead.
            this.dispatchEvent(
              new CustomEvent('pane-select', { detail: { paneId }, bubbles: true, composed: true }),
            );
            // Re-assert as the LAST word. The synchronous setActive(above) holds
            // through the microtask but is clobbered on the next animation frame:
            // terminals attach via a deferred rAF and each calls term.focus(),
            // and dockview activates a group on focus (onDidFocus). The attach
            // focus-storm lands on the stale store-default pane, reverting the
            // active group. Re-activating AND focusing the restored pane after
            // those frames makes it stick (and leaves it keyboard-focused).
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (this._panels.get(paneId)?.api.setActive) {
                  this._panels.get(paneId)?.api.setActive();
                  terminalRegistry.focus(paneId);
                }
              });
            });
          }
        } else {
          // Fresh tab build — honor the store's active pane.
          const activePanel = this._panels.get(this.activePaneId);
          if (activePanel) {
            activePanel.api.setActive();
          }
        }
      } finally {
        this._settingActive = false;
        this._removingPanels = false;
      }
      this._refreshBellTitles();
      return;
    }

    // Case 2: panes changed → diff (add/remove panels)
    if (changed.has('panes')) {
      const currentPaneIds = new Set(this.panes.filter((p) => p.paneId >= 0).map((p) => p.paneId));

      // Remove panels for panes that were removed server-side.
      // Guard with _removingPanels so onDidRemovePanel doesn't re-fire pane-close.
      this._removingPanels = true;
      try {
        for (const [paneId, panel] of this._panels) {
          if (!currentPaneIds.has(paneId)) {
            this._dv.removePanel(panel);
            this._panels.delete(paneId);
          }
        }
      } finally {
        this._removingPanels = false;
      }

      // Add panels for new panes, skipping panes the user closed locally.
      for (const pane of this.panes.filter((p) => p.paneId >= 0)) {
        if (!this._panels.has(pane.paneId) && !this._locallyClosedPanes.has(pane.paneId)) {
          const opts: Parameters<NonNullable<typeof this._dv>['addPanel']>[0] = {
            id: String(pane.paneId),
            component: pane.surfaceKind ?? 'terminal',
            title: this._customTitles.get(pane.paneId) ?? pane.title ?? `Pane ${pane.paneId}`,
          };
          // Honor a pending placement request, positioned relative to the group
          // whose header button was clicked (so "+" / split on an INACTIVE
          // group targets THAT group, not the active one).
          if (this._nextPlacement === 'split' && this._splitReferenceId !== null) {
            // New side-by-side group to the right of the clicked group.
            opts.position = { referencePanel: this._splitReferenceId, direction: 'right' };
          } else if (this._nextPlacement === 'tab' && this._placementReferenceId !== null) {
            // New tab WITHIN the clicked group (also activates that group).
            opts.position = { referencePanel: this._placementReferenceId, direction: 'within' };
          }
          // Reset placement intent now that it's been consumed.
          this._nextPlacement = 'tab';
          this._splitReferenceId = null;
          this._placementReferenceId = null;
          const panel = this._dv.addPanel(opts);
          this._panels.set(pane.paneId, panel);
        }
      }
    }

    // Case 3: activePaneId changed → set active panel
    if (changed.has('activePaneId')) {
      muxLog('dock case3', `activePaneId changed to ${this.activePaneId}`,
        { panels: [...this._panels.keys()], prevActivePaneId: changed.get('activePaneId') });
      const panel = this._panels.get(this.activePaneId);
      if (panel && !panel.api.isActive) {
        this._settingActive = true;
        try {
          panel.api.setActive();
        } finally {
          this._settingActive = false;
        }
        // onDidActivePanelChange is suppressed while _settingActive=true, so
        // focus would never be placed in the terminal for programmatic pane
        // switches (store-driven: pane-picker, initial load, workspace restore).
        // rAF: same reason as onDidActivePanelChange — defer until after the
        // browser finishes resolving focus for the panel/tab element.
        const paneIdToFocus = this.activePaneId;
        requestAnimationFrame(() => terminalRegistry.focus(paneIdToFocus));
      }
    }
    // Bell dot updates are reactive without a direct store.subscribe() here:
    // mux-app.render() passes store.panes.filter() which always returns a new
    // array reference on every store notification. Lit tracks the new reference
    // as a changed property and triggers this updated() call, which then calls
    // _refreshBellTitles(). If the render path ever caches the filtered array,
    // this reactivity chain would silently break — hence this comment.
    this._refreshBellTitles();
  }

  /**
   * Read xterm.js buffer for playwright verification.
   * Returns the full scrollback buffer content as a newline-joined string.
   */
  getTerminalContent(paneId: number): string {
    const term = terminalRegistry.getTerminal(paneId);
    if (!term) return '';
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  }

  /**
   * Undo a local close: re-enable the reconciler for this pane and re-add its
   * dockview panel immediately. The server never heard about the close during
   * the grace period, so store.panes still has the entry, the PTY is alive, and
   * terminalRegistry still holds the xterm instance — the panel comes back with
   * full scrollback. Position is NOT preserved (re-adds at the default slot).
   */
  reopenPane(paneId: number): void {
    this._locallyClosedPanes.delete(paneId);
    if (!this._dv) return;
    if (this._panels.has(paneId)) return; // already on screen, nothing to do
    const pane = this.panes.find((p) => p.paneId === paneId);
    if (!pane) return; // pane no longer exists (e.g. process exited during grace)
    const panel = this._dv.addPanel({
      id: String(paneId),
      component: pane.surfaceKind ?? 'terminal',
      title: this._customTitles.get(paneId) ?? pane.title ?? `Pane ${paneId}`,
    });
    this._panels.set(paneId, panel);
    panel.api.setActive();
  }

  /**
   * Re-enable reconciliation for a set of pane IDs that were locally closed
   * but whose server-side PTY survived (e.g. grace-period cancel on disconnect).
   * The reconciler will re-add their tabs on the next render cycle.
   */
  allowReconcile(paneIds: Iterable<number>): void {
    for (const id of paneIds) {
      this._locallyClosedPanes.delete(id);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-dock': MuxDock;
  }
}
