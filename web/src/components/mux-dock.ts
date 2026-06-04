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

  constructor(id: string) {
    this._paneId = parseInt(id, 10);
    const el = document.createElement('div');
    el.style.cssText = 'width:100%;height:100%;overflow:hidden;';
    this.element = el;
  }

  init(): void {
    // Defer attach until after the browser has painted and dockview has settled
    // its panel dimensions. Without this, the terminal opens at wrong dimensions,
    // the buffered PTY replay renders garbled ($$$$~~~~~), and a subsequent fit
    // can't fix already-drawn content.
    requestAnimationFrame(() => {
      if (terminalRegistry.getTerminal(this._paneId) !== null) {
        terminalRegistry.attach(this._paneId, this.element);
      } else {
        this._pendingMount = true;
        console.warn(`[mux-dock] TerminalRenderer.init: pane ${this._paneId} not yet in registry — deferring attach`);
      }
    });
  }

  layout(): void {
    if (this._pendingMount && terminalRegistry.getTerminal(this._paneId) !== null) {
      this._pendingMount = false;
      terminalRegistry.attach(this._paneId, this.element);
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
// RenameableTab
// Custom tab renderer: shows pane title, double-click to rename inline.
// ─────────────────────────────────────────────────────────────────────────────

class RenameableTab {
  readonly element: HTMLElement;
  private readonly _span: HTMLSpanElement;
  private readonly _input: HTMLInputElement;
  private _paneId = 0;
  private _title = '';

  constructor(private readonly _customTitles: Map<number, string>) {
    this.element = document.createElement('div');
    this.element.className = 'mux-tab-label';

    this._span = document.createElement('span');
    this._span.className = 'mux-tab-label__text';

    this._input = document.createElement('input');
    this._input.className = 'mux-tab-label__input';
    this._input.type = 'text';
    this._input.style.display = 'none';

    this.element.appendChild(this._span);
    this.element.appendChild(this._input);

    this._span.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this._startEdit();
    });
    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._commit(); }
      if (e.key === 'Escape') { e.preventDefault(); this._cancel(); }
      e.stopPropagation(); // don't leak keystrokes to dockview / xterm
    });
    this._input.addEventListener('blur', () => this._commit());
  }

  init(params: { api: { id: string; title?: string } }): void {
    this._paneId = parseInt(params.api.id, 10);
    // Use stored custom title if one exists, otherwise use the panel default.
    this._title = this._customTitles.get(this._paneId) ?? params.api.title ?? `Pane ${this._paneId}`;
    this._span.textContent = this._title;
  }

  // update() is optional in ITabRenderer; title changes are handled via init() +
  // the double-click rename flow.  No external callers pass a new title here.

  dispose(): void {}

  private _startEdit(): void {
    this._input.value = this._title;
    this._input.style.display = '';
    this._span.style.display = 'none';
    this._input.focus();
    this._input.select();
  }

  private _commit(): void {
    const next = this._input.value.trim() || this._title;
    this._title = next;
    this._customTitles.set(this._paneId, next);
    this._span.textContent = next;
    this._input.style.display = 'none';
    this._span.style.display = '';
  }

  private _cancel(): void {
    this._input.style.display = 'none';
    this._span.style.display = '';
  }
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

        /* Renameable tab label */
        mux-dock .mux-tab-label {
          display: flex;
          align-items: center;
          height: 100%;
          padding: 0 4px;
          max-width: 160px;
          overflow: hidden;
        }
        mux-dock .mux-tab-label__text {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          user-select: none;
          cursor: default;
        }
        mux-dock .mux-tab-label__text:hover {
          color: #c0caf5;
        }
        mux-dock .mux-tab-label__input {
          width: 100%;
          min-width: 60px;
          background: #24283b;
          color: #c0caf5;
          border: 1px solid #7aa2f7;
          border-radius: 3px;
          padding: 1px 4px;
          font: inherit;
          font-size: inherit;
          outline: none;
        }
      `;
      target.appendChild(style);
    }

    this.classList.add('dockview-theme-dark');
    this._dv = new DockviewComponent(this, {
      createComponent: (opts) => new TerminalRenderer(opts.id),
      createTabComponent: () => new RenameableTab(this._customTitles),
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
