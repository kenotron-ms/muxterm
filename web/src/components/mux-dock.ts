import { LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { IDockviewPanel, IContentRenderer } from 'dockview-core';
import { DockviewComponent } from 'dockview-core';
import 'dockview-core/dist/styles/dockview.css';
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
    if (terminalRegistry.getTerminal(this._paneId) !== null) {
      terminalRegistry.attach(this._paneId, this.element);
    } else {
      this._pendingMount = true;
      console.warn(`[mux-dock] TerminalRenderer.init: pane ${this._paneId} not yet in registry — deferring attach`);
    }
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

    // Inject Tokyo Night theme overrides for dockview into document.head.
    // static styles cannot be used here because createRenderRoot() returns
    // `this` (light DOM mode, required for dockview). In light DOM mode Lit's
    // adoptStyles() is never called — the static styles block is dead code.
    // Injecting a <style> tag into document.head is the correct workaround.
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        mux-dock {
          display: block;
          flex: 1;
          width: 100%;
          height: 100%;
        }
        /* Tokyo Night color overrides for dockview */
        mux-dock .dv-dockview {
          --dv-background-color: #1a1b26;
          --dv-separator-border: #292e42;
          --dv-tabs-and-actions-container-background-color: #16161e;
          --dv-activegroup-visiblepanel-tab-background-color: #1a1b26;
          --dv-activegroup-hiddenpanel-tab-background-color: #16161e;
          --dv-inactivegroup-visiblepanel-tab-background-color: #16161e;
          --dv-inactivegroup-hiddenpanel-tab-background-color: #16161e;
          --dv-tab-divider-color: #292e42;
          --dv-activegroup-visiblepanel-tab-color: #c0caf5;
          --dv-activegroup-hiddenpanel-tab-color: #565f89;
          --dv-inactivegroup-visiblepanel-tab-color: #565f89;
          --dv-inactivegroup-hiddenpanel-tab-color: #565f89;
          --dv-drag-over-background-color: rgba(122, 162, 247, 0.15);
          --dv-drag-over-border-color: #7aa2f7;
          --dv-drop-target-background: rgba(122, 162, 247, 0.1);
        }
      `;
      document.head.appendChild(style);
    }

    this.classList.add('dockview-theme-dark');
    this._dv = new DockviewComponent(this, {
      createComponent: (opts) => new TerminalRenderer(opts.id),
      createRightHeaderActionComponent: undefined,
      createLeftHeaderActionComponent: undefined,
    });
    this._dv.onDidActivePanelChange((panel) => {
      if (this._settingActive) return;
      if (!panel) return;
      const paneId = parseInt(panel.id, 10);
      this.dispatchEvent(new CustomEvent('pane-select', { detail: { paneId }, bubbles: true, composed: true }));
      terminalRegistry.focus(paneId);
    });
    // Detect when the user closes a tab via the dockview close (X) button.
    // We track these as "locally closed" so the reconciler doesn't re-add them.
    this._dv.onDidRemovePanel((panel) => {
      if (this._removingPanels) return; // programmatic removal — ignore
      const paneId = parseInt(panel.id, 10);
      if (this._panels.has(paneId)) {
        this._panels.delete(paneId);
        this._locallyClosedPanes.add(paneId);
        this.dispatchEvent(
          new CustomEvent('pane-close', { detail: { paneId }, bubbles: true, composed: true }),
        );
      }
      // Force dockview to re-layout so the remaining panel fills the space.
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
            title: pane.title ?? `Pane ${pane.paneId}`,
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
            title: pane.title ?? `Pane ${pane.paneId}`,
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
