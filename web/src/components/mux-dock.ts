import { LitElement, css } from 'lit';
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

@customElement('mux-dock')
export class MuxDock extends LitElement {
  // Light DOM is REQUIRED for dockview CSS and DnD to work.
  override createRenderRoot() {
    return this;
  }

  static styles = css`
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

  @property({ attribute: false }) panes: SessiondPaneInfo[] = [];
  @property({ attribute: false }) activePaneId = -1;
  @property({ attribute: false }) workspaceKey = '';

  private _dv: DockviewComponent | null = null;
  private _panels = new Map<number, IDockviewPanel>();
  private _settingActive = false;

  override connectedCallback(): void {
    super.connectedCallback();
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
      try {
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
      }
      return;
    }

    // Case 2: panes changed → diff (add/remove panels)
    if (changed.has('panes')) {
      const currentPaneIds = new Set(this.panes.filter((p) => p.paneId >= 0).map((p) => p.paneId));

      // Remove panels for gone panes
      for (const [paneId, panel] of this._panels) {
        if (!currentPaneIds.has(paneId)) {
          this._dv.removePanel(panel);
          this._panels.delete(paneId);
        }
      }

      // Add panels for new panes
      for (const pane of this.panes.filter((p) => p.paneId >= 0)) {
        if (!this._panels.has(pane.paneId)) {
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
   * Returns the visible viewport content as a newline-joined string.
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
