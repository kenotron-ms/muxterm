import { LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { IDockviewPanel, IContentRenderer } from 'dockview-core';
import { DockviewComponent } from 'dockview-core';
import dockviewCss from 'dockview-core/dist/styles/dockview.css?inline';
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
      // First layout() call — dockview has now settled the panel dimensions.
      // Safe to open the terminal here; it will open at the correct size and
      // the PTY replay will render without garbling.
      if (terminalRegistry.getTerminal(this._paneId) !== null) {
        this._attached = true;
        this._pendingMount = false;
        terminalRegistry.attach(this._paneId, this.element);
        // attach() calls fitIfVisible() internally, so we're done.
        return;
      }
      // Registry not ready yet — will retry on next layout() call.
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
// SplitButton
// Right-side header action: one button per tab group that creates a new pane.
// ─────────────────────────────────────────────────────────────────────────────

class SplitButton {
  readonly element: HTMLElement;

  constructor(private readonly _onSplit: () => void) {
    const btn = document.createElement('button');
    btn.className = 'mux-split-btn';
    btn.title = 'Split pane';
    // VS Code-style split icon: two side-by-side rectangles
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="2" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/>
      <rect x="9" y="2" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/>
    </svg>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._onSplit();
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
  // Light DOM is REQUIRED for dockview CSS and DnD to work.
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) panes: SessiondPaneInfo[] = [];
  @property({ attribute: false }) activePaneId = -1;
  @property({ attribute: false }) workspaceKey = '';

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

  override connectedCallback(): void {
    super.connectedCallback();

    // mux-dock is a light-DOM element but lives inside mux-app's ShadowRoot.
    // All styles must be injected into that ShadowRoot — document.head styles
    // cannot pierce a shadow boundary.
    const root = this.getRootNode();
    const target = root instanceof ShadowRoot ? root : document.head;

    // Inject dockview's full CSS (base layout + all themes) into the shadow root.
    // Must live here so dockview's theme class selectors can reach panel elements.
    const BASE_ID = 'dockview-base-css';
    if (!target.querySelector(`#${BASE_ID}`)) {
      const base = document.createElement('style');
      base.id = BASE_ID;
      base.textContent = dockviewCss;
      target.appendChild(base);
    }

    // Inject Tokyo Night overrides on top of dockview-theme-dark.
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

        /* Tokyo Night overrides — sit on top of dockview-theme-dark */
        mux-dock .dv-dockview {
          --dv-background-color: #1a1b26;
          --dv-separator-border: #292e42;

          /* Tab bar — visible separation from terminal content */
          --dv-tabs-and-actions-container-background-color: #1f2335;
          --dv-group-view-background-color: #1a1b26;

          /* Active group tabs */
          --dv-activegroup-visiblepanel-tab-background-color: #1a1b26;
          --dv-activegroup-hiddenpanel-tab-background-color: #1f2335;
          /* Inactive group tabs */
          --dv-inactivegroup-visiblepanel-tab-background-color: #1f2335;
          --dv-inactivegroup-hiddenpanel-tab-background-color: #1f2335;

          --dv-tab-divider-color: #292e42;

          /* Text: active tab bright, inactive tabs readable */
          --dv-activegroup-visiblepanel-tab-color: #c0caf5;
          --dv-activegroup-hiddenpanel-tab-color: #a9b1d6;
          --dv-inactivegroup-visiblepanel-tab-color: #a9b1d6;
          --dv-inactivegroup-hiddenpanel-tab-color: #565f89;

          /* Sash (resize handle) */
          --dv-sash-color: #292e42;
          --dv-active-sash-color: #7aa2f7;

          /* Close button */
          --dv-tab-close-icon-size: 10px;

          /* Drag */
          --dv-drag-over-background-color: rgba(122, 162, 247, 0.15);
          --dv-drag-over-border-color: #7aa2f7;
          --dv-drop-target-background: rgba(122, 162, 247, 0.1);
        }

        /* Active tab accent line — applied to any active tab regardless of
           group focus state so it shows on initial render too. */
        mux-dock .dv-tab.dv-active-tab {
          border-top: 2px solid #7aa2f7 !important;
        }
        mux-dock .dv-tab.dv-inactive-tab {
          border-top: 2px solid transparent;
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

        /* Split pane button — top-right of every tab group */
        mux-dock .mux-split-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          margin: auto 4px;
          padding: 0;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: #a9b1d6;
          cursor: pointer;
          flex-shrink: 0;
          transition: background 0.12s, color 0.12s;
        }
        mux-dock .mux-split-btn:hover {
          background: rgba(122, 162, 247, 0.15);
          color: #c0caf5;
        }
        mux-dock .mux-split-btn:active {
          background: rgba(122, 162, 247, 0.25);
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

    this.classList.add('dockview-theme-dark');
    this.addEventListener('dblclick', this._onTabDblClick);
    this._dv = new DockviewComponent(this, {
      createComponent: (opts) => new TerminalRenderer(opts.id),
      createRightHeaderActionComponent: () =>
        new SplitButton(() => {
          this.dispatchEvent(
            new CustomEvent('pane-create', { bubbles: true, composed: true }),
          );
        }),
      createLeftHeaderActionComponent: undefined,
    });
    this._dv.onDidActivePanelChange((panel) => {
      if (this._settingActive) return;
      if (!panel) return;
      const paneId = parseInt(panel.id, 10);
      this.dispatchEvent(new CustomEvent('pane-select', { detail: { paneId }, bubbles: true, composed: true }));
      terminalRegistry.focus(paneId);
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

        // Add fresh panels for panes with valid paneId
        for (const pane of this.panes.filter((p) => p.paneId >= 0)) {
          const panel = this._dv.addPanel({
            id: String(pane.paneId),
            component: 'terminal',
            title: this._customTitles.get(pane.paneId) ?? pane.title ?? `Pane ${pane.paneId}`,
          });
          this._panels.set(pane.paneId, panel);
        }

        // Set active panel
        const activePanel = this._panels.get(this.activePaneId);
        if (activePanel) {
          activePanel.api.setActive();
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
          const panel = this._dv.addPanel({
            id: String(pane.paneId),
            component: 'terminal',
            title: this._customTitles.get(pane.paneId) ?? pane.title ?? `Pane ${pane.paneId}`,
          });
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
