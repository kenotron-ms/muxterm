import { LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { IDockviewPanel, IContentRenderer, SerializedDockview, DockviewGroupPanel } from 'dockview-core';
import { DockviewComponent } from 'dockview-core';
import dockviewCss from 'dockview-core/dist/styles/dockview.css?inline';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import { terminalRegistry } from '../lib/terminal-registry.js';
import type { SessiondPaneInfo } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// TerminalRenderer
// Bridges the dockview panel lifecycle to terminalRegistry.
// ─────────────────────────────────────────────────────────────────────────────

class TerminalRenderer implements IContentRenderer {
  readonly element: HTMLElement;
  private readonly _paneId: number;
  private _pendingMount = false;
  private _attached = false;

  constructor(id: string) {
    this._paneId = parseInt(id, 10);
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
    // We attach in the first layout() call instead, which is guaranteed to
    // fire after dockview has settled the panel size.
    if (terminalRegistry.getTerminal(this._paneId) === null) {
      this._pendingMount = true;
    }
  }

  layout(): void {
    if (!this._attached) {
      // Attach (open the xterm surface) only once the panel element is BOTH
      // connected to the live shadow DOM AND has real pixel dimensions.
      //
      // The `isConnected` gate is critical for the layout-restore path:
      // dockview's fromJSON() builds groups in a DETACHED subtree and calls
      // layout() on the active panel BEFORE appending that subtree to the DOM.
      // Attaching then would:
      //   - inject xterm.css via container.getRootNode() into the wrong root
      //     (a detached fragment, not mux-app's shadow root) → measurement
      //     elements leak as $$$$~~~~;
      //   - set the terminal `opened` flag while the element is unsized, so the
      //     PTY replay (arriving as later WebSocket frames) writes directly at
      //     the wrong cols/rows → repeated/garbled prompt; and
      //   - bypass pendingData, so the deferred fonts.ready drain has nothing
      //     to replay → missing scrollback history.
      //
      // Gating on isConnected defers attach to the post-append layout() call
      // (from gridview.layout()), when the element is in the shadow DOM with
      // real dimensions. Replay then queues in pendingData while opened=false
      // and is drained at the correct, font-settled size — the same path the
      // fresh-tab flow already uses successfully.
      //
      // Gate ONLY on isConnected — NOT on offsetWidth/offsetHeight. During a
      // fromJSON restore dockview lays the grid out at 0x0 first (its
      // ResizeObserver settles real dimensions a frame later), so a re-shown
      // non-active panel's element is connected but momentarily 0-sized. If we
      // also required offsetWidth>0 here, that panel would never attach (its
      // only layout() call arrives at 0x0) and would render blank/historyless
      // until an unrelated resize. attach() calls fitIfVisible(), which itself
      // no-ops while the element is invisible/zero-sized and re-fits correctly
      // on the next ResizeObserver tick — so attaching at 0x0 is safe.
      if (
        terminalRegistry.getTerminal(this._paneId) !== null &&
        this.element.isConnected
      ) {
        this._attached = true;
        this._pendingMount = false;
        terminalRegistry.attach(this._paneId, this.element);
        // attach() calls fitIfVisible() internally, so we're done.
        return;
      }
      // Not ready yet (registry missing, or element still detached) — retry on
      // the next layout() call, which dockview fires once the panel is in the
      // live DOM.
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
  /** User-defined pane names — persists across workspace switches for the session. */
  private _customTitles = new Map<number, string>();
  /**
   * Pane IDs closed by the user via the dockview tab X button.
   * These are excluded from reconciler re-adds (Case 2) until the
   * workspace changes (Case 1 clears this set).
   */
  private _locallyClosedPanes = new Set<number>();
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

        /* Selection cue: a blue top accent on the visible (selected) tab, a
           transparent reserve on every other tab so heights stay aligned. */
        mux-dock .dv-tab {
          border-top: 2px solid transparent;
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
      `;
      target.appendChild(style);
    }

    this.classList.add('dockview-theme-abyss');
    this.addEventListener('dblclick', this._onTabDblClick);
    this._dv = new DockviewComponent(this, {
      createComponent: (opts) => new TerminalRenderer(opts.id),
      // dockview header DOM order is: [tabs] [left-actions] [void] [right-actions].
      // The "left" slot therefore renders immediately after the tabs (before
      // the grow-to-fill void), and the "right" slot renders far right.
      //   "+"    → left slot  → sits just right of the tabs (new pane as a TAB)
      //   split  → right slot → far right (split into a side-by-side group)
      // The factory receives the dockview group its header belongs to, so the
      // "+" / split on an INACTIVE group still targets THAT group.
      createLeftHeaderActionComponent: (group) =>
        new HeaderButton(ADD_ICON, 'New pane', () => this._requestPane('tab', group)),
      // Narrow (phone) is a tab view only — no split button.
      createRightHeaderActionComponent: (group) =>
        this.narrow
          ? new HeaderButton('', '', () => {})
          : new HeaderButton(SPLIT_ICON, 'Split pane', () => this._requestPane('split', group)),
    });
    this._dv.onDidLayoutChange(() => this._scheduleLayoutSave());
    this._dv.onDidActivePanelChange((panel) => {
      if (this._settingActive) return;
      if (!panel) return;
      const paneId = parseInt(panel.id, 10);
      this.dispatchEvent(new CustomEvent('pane-select', { detail: { paneId }, bubbles: true, composed: true }));
      terminalRegistry.focus(paneId);
      // Persist the new active selection: onDidLayoutChange does NOT fire on a
      // pure active-tab switch, so without this the saved layout keeps a stale
      // activeView and the wrong pane is selected after a refresh.
      this._scheduleLayoutSave();
    });
    this._dv.onDidRemovePanel((panel) => {
      if (this._removingPanels) return;
      const paneId = parseInt(panel.id, 10);
      if (this._panels.has(paneId)) {
        this._panels.delete(paneId);
        this._locallyClosedPanes.add(paneId);
        this.dispatchEvent(
          new CustomEvent('pane-close', { detail: { paneId }, bubbles: true, composed: true }),
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
    const currentTitle = tabContent.textContent ?? '';

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
      tabContent.textContent = next;
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
                  component: 'terminal',
                  title: this._customTitles.get(pane.paneId) ?? pane.title ?? `Pane ${pane.paneId}`,
                });
                this._panels.set(pane.paneId, panel);
              }
            }
            restored = this._panels.size > 0;
          } catch {
            // Corrupt/incompatible layout — fall back to a clean tab build.
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
              component: 'terminal',
              title: this._customTitles.get(pane.paneId) ?? pane.title ?? `Pane ${pane.paneId}`,
            });
            this._panels.set(pane.paneId, panel);
          }
        }

        if (restored) {
          // fromJSON already restored the saved active group + per-group active
          // view. Do NOT force activePaneId (which the store hard-codes to
          // panes[0]) — that would clobber the restored selection. Instead,
          // sync the store to dockview's restored truth so they agree.
          const restoredActive = this._dv.activePanel?.id;
          if (restoredActive !== undefined) {
            const paneId = parseInt(restoredActive, 10);
            this.dispatchEvent(
              new CustomEvent('pane-select', { detail: { paneId }, bubbles: true, composed: true }),
            );
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
            component: 'terminal',
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
      const panel = this._panels.get(this.activePaneId);
      if (panel && !panel.api.isActive) {
        this._settingActive = true;
        try {
          panel.api.setActive();
        } finally {
          this._settingActive = false;
        }
      }
    }
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
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-dock': MuxDock;
  }
}
