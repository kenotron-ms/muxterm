import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { Workspace, Region } from '../lib/workspace.js';
import type { TmuxState, Window, SessionInfo } from '../types.js';
import { CellBudgetManager } from '../lib/cell-budget.js';
import { ResizeCoalescer } from '../lib/resize-coalescer.js';
import type { CellMetrics, PixelBox } from '../lib/cell-budget.js';
import { popoutManager, PopoutManager } from '../lib/popout.js';
import './region.js';
import './region-divider.js';
import type { MuxRegion } from './region.js';
import type { RegionAction } from './region-menu.js';

type Item =
  | { type: 'region'; region: Region }
  | { type: 'divider'; idx: number };

@customElement('mux-workspace')
export class MuxWorkspace extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex: 1;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #1a1b26;
    }

    .region-slot {
      display: flex;
      overflow: hidden;
    }
  `;

  @property({ attribute: false })
  workspace!: Workspace;

  @property({ attribute: false })
  tmuxState!: TmuxState;

  /**
   * Injectable pop-out manager — defaults to the app-wide singleton but can
   * be replaced in tests with a PopoutManager using a fake window opener.
   * @internal
   */
  _popoutManager: PopoutManager = popoutManager;

  /** Regions that have been detached (popped out) — preserved for remount. */
  private _detachedRegions = new Map<string, Region>();

  /**
   * Optimistic window selection: records the windowId the user just clicked
   * before the server round-trip completes. Keyed by sessionName.
   * Cleared when the server confirms a tmuxState update for that session.
   */
  @state() private _optimisticWindows = new Map<string, number>();

  /**
   * Optimistic window rename: records the name the user just typed before the
   * server round-trip completes. Keyed by windowId.
   * Cleared when the server confirms a tmuxState update containing that window.
   */
  @state() private _optimisticWindowNames = new Map<number, string>();

  // Two-clock plumbing: ResizeObserver → budget → coalescer → resize-surface event

  private _coalescer = new ResizeCoalescer((surfaceId, budget) => {
    this.dispatchEvent(new CustomEvent('resize-surface', {
      bubbles: true, composed: true,
      detail: { surfaceId, cols: budget.cols, rows: budget.rows },
    }));
  });

  private _budget = new CellBudgetManager((surfaceId, budget) => {
    this._coalescer.push(surfaceId, budget);
  });

  private _findWindow(sessionName: string, windowId: number): Window | undefined {
    const session = this.tmuxState?.sessions.find((s) => s.name === sessionName);
    return session?.windows.find((w) => w.id === windowId);
  }

  private _sessionWindows(sessionName: string): Window[] {
    return this.tmuxState?.sessions.find((s) => s.name === sessionName)?.windows ?? [];
  }

  private _sessionActiveWindowId(sessionName: string): number {
    // Check optimistic override first — gives instant response before server confirms.
    if (this._optimisticWindows.has(sessionName)) {
      return this._optimisticWindows.get(sessionName)!;
    }
    // For the currently-active session, tmuxState.activeWindow is authoritative.
    if (this.tmuxState?.activeSession === sessionName) {
      return this.tmuxState.activeWindow ?? 0;
    }
    // For other sessions in the dock, default to the first window.
    const session = this.tmuxState?.sessions.find((s) => s.name === sessionName);
    return session?.windows[0]?.id ?? 0;
  }

  /** Per-drag state: initial pixel widths and which regions are being resized. */
  private _dragState: {
    leftIdx: number;
    rightIdx: number;
    leftStart: number;
    rightStart: number;
    totalWidth: number;
  } | null = null;

  private _onResizeDrag = (e: Event): void => {
    const event = e as CustomEvent<{ deltaX: number; deltaY: number }>;
    if (!this.workspace) return;
    const regions = this.workspace.visibleRegions;
    if (regions.length < 2) return;

    // Identify which divider dispatched the event (by position in composedPath)
    const dividers = Array.from(this.shadowRoot!.querySelectorAll('mux-region-divider'));
    const path = event.composedPath();
    let dividerIdx = 0;
    for (let i = 0; i < dividers.length; i++) {
      if (path.includes(dividers[i])) {
        dividerIdx = i;
        break;
      }
    }

    const leftIdx = dividerIdx;
    const rightIdx = dividerIdx + 1;
    if (leftIdx >= regions.length || rightIdx >= regions.length) return;

    // Initialise drag state on first event for this drag session
    if (!this._dragState || this._dragState.leftIdx !== leftIdx) {
      const slots = Array.from(this.shadowRoot!.querySelectorAll<HTMLElement>('.region-slot'));
      const leftSlot = slots[leftIdx];
      const rightSlot = slots[rightIdx];

      const totalWeight = this.workspace.regions.reduce((s, r) => s + r.weight, 0);
      // Use actual DOM width when available; fall back to 400 px for jsdom/test env
      const totalPx = Math.max(
        leftSlot?.getBoundingClientRect().width ?? 0,
        this.getBoundingClientRect().width,
        this.clientWidth,
        400,
      ) + Math.max(
        rightSlot?.getBoundingClientRect().width ?? 0,
        0,
      );
      const domTotal = Math.max(totalPx, 400);

      const leftRatio = regions[leftIdx].weight / totalWeight;
      const rightRatio = regions[rightIdx].weight / totalWeight;
      this._dragState = {
        leftIdx,
        rightIdx,
        leftStart: leftRatio * domTotal,
        rightStart: rightRatio * domTotal,
        totalWidth: domTotal,
      };
    }

    const { leftStart, rightStart } = this._dragState;
    const deltaX = event.detail.deltaX;
    const MIN_PX = 20;
    const newLeft = Math.max(MIN_PX, leftStart + deltaX);
    const newRight = Math.max(MIN_PX, rightStart - deltaX);
    const newTotal = newLeft + newRight;

    // Mutate the actual region objects (visibleRegions returns a copy of the array)
    const leftRegion = this.workspace.regions.find((r) => r.id === regions[leftIdx].id);
    const rightRegion = this.workspace.regions.find((r) => r.id === regions[rightIdx].id);
    if (leftRegion && rightRegion) {
      leftRegion.weight = newLeft / newTotal;
      rightRegion.weight = newRight / newTotal;
      this.requestUpdate();
    }
  };

  private _onResizeEnd = (): void => {
    this._dragState = null;
  };

  private _onMaximize = (e: Event): void => {
    if (!this.workspace) return;
    const event = e as CustomEvent<{ regionId: string }>;
    const { regionId } = event.detail;
    if (this.workspace.maximizedRegionId === regionId) {
      this.workspace.restore();
    } else {
      this.workspace.maximize(regionId);
    }
    this.requestUpdate();
  };

  // ---------------------------------------------------------------------------
  // Region menu orchestration
  // ---------------------------------------------------------------------------

  /**
   * Handles `region-action` events bubbled from `<mux-region-menu>` via the
   * region-tabstrip and region components. The regionId comes from the closure
   * set up in _renderRegion so we always know which region acted.
   */
  private _handleRegionAction(regionId: string, action: RegionAction, activePaneId: number = -1): void {
    switch (action) {
      case 'split-right':
        this._splitRegion(regionId, 'horizontal', activePaneId);
        break;

      case 'split-down':
        this._splitRegion(regionId, 'vertical', activePaneId);
        break;

      case 'rename':
        this._renameRegionWindow(regionId);
        break;

      case 'close-region':
        this._closeRegion(regionId);
        break;

      case 'pop-out':
        try {
          this._popoutManager.popOut({
            regionId,
            onClose: () => this._remountRegion(regionId),
          });
          // MOVES the surface — detach only after successful popOut call
          this._detachRegion(regionId);
        } catch (err) {
          if ((err as Error).message === 'popout-blocked') {
            // Keep the region docked — NEVER lose it
            console.warn(
              `[mux-workspace] pop-out blocked for region "${regionId}" — keeping docked`,
            );
          } else {
            throw err;
          }
        }
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Region lifecycle helpers
  // ---------------------------------------------------------------------------

  /** Split the active pane of a region horizontally or vertically. */
  private _splitRegion(_regionId: string, direction: 'horizontal' | 'vertical', paneId: number): void {
    if (paneId < 0) return;
    this.dispatchEvent(new CustomEvent('split-pane', {
      bubbles: true,
      composed: true,
      detail: { direction, paneId },
    }));
  }

  /** Prompt for a new name and rename the tmux window associated with a region. */
  private _renameRegionWindow(regionId: string): void {
    const region = this.workspace.regions.find((r) => r.id === regionId);
    if (!region) return;
    const windowId = this._sessionActiveWindowId(region.surface.sessionName);
    const win = this._findWindow(region.surface.sessionName, windowId);
    const newName = window.prompt('Rename window:', win?.name ?? '');
    if (newName !== null && newName.trim() !== '') {
      const trimmed = newName.trim();
      // Optimistically show the new name immediately before server confirms.
      this._optimisticWindowNames = new Map(
        this._optimisticWindowNames.set(windowId, trimmed)
      );
      this.dispatchEvent(new CustomEvent('rename-window', {
        bubbles: true,
        composed: true,
        detail: { windowId, name: trimmed },
      }));
    }
  }

  /** Close a region and remove it from the workspace. */
  private _closeRegion(regionId: string): void {
    if (!this.workspace) return;
    this.workspace.closeRegion(regionId);
    this.requestUpdate();
  }

  /**
   * Remove a region from the in-page layout without destroying it.
   * The region data is stored in `_detachedRegions` so it can be remounted.
   */
  private _detachRegion(regionId: string): void {
    if (!this.workspace) return;
    const region = this.workspace.regions.find((r) => r.id === regionId);
    if (!region) return;
    this._detachedRegions.set(regionId, region);
    this.workspace.regions = this.workspace.regions.filter((r) => r.id !== regionId);
    this.workspace.detachedRegionIds.add(regionId);
    this.requestUpdate();
  }

  /**
   * Re-add a previously detached region back into the in-page layout.
   * Called by the pop-out manager's `onClose` callback.
   */
  private _remountRegion(regionId: string): void {
    const region = this._detachedRegions.get(regionId);
    if (!region || !this.workspace) return;
    this._detachedRegions.delete(regionId);
    this.workspace.regions.push(region);
    this.workspace.detachedRegionIds.delete(regionId);
    this.requestUpdate();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected override updated(changedProperties: Map<string, unknown>): void {
    if (!this.workspace) return;
    const regionEls = this.shadowRoot?.querySelectorAll('mux-region') as NodeListOf<MuxRegion> | undefined;
    if (!regionEls) return;

    for (const region of this.workspace.visibleRegions) {
      const regionEl = Array.from(regionEls).find((el) => el.surfaceId === region.surface.id);
      if (!regionEl) continue;
      const body = regionEl.bodyElement;
      if (!body) continue;
      const metrics = this._cellMetricsFor(region.surface.id);
      if (!metrics) continue;
      this._budget.observe(region.surface.id, body, metrics);
    }

    // Clear optimistic window selections once the server has confirmed a
    // tmuxState update for the affected session — the server is now authoritative.
    if (changedProperties.has('tmuxState') && this.tmuxState && this._optimisticWindows.size > 0) {
      const next = new Map(this._optimisticWindows);
      let changed = false;
      for (const [sessionName] of next) {
        const session = this.tmuxState.sessions.find((s) => s.name === sessionName);
        if (session) {
          next.delete(sessionName);
          changed = true;
        }
      }
      if (changed) this._optimisticWindows = next;
    }

    // Clear optimistic window renames once the server has confirmed a
    // tmuxState update containing the affected window — server is now authoritative.
    if (changedProperties.has('tmuxState') && this.tmuxState && this._optimisticWindowNames.size > 0) {
      const next = new Map(this._optimisticWindowNames);
      let changed = false;
      for (const [windowId] of next) {
        for (const session of this.tmuxState.sessions) {
          const win = session.windows.find((w) => w.id === windowId);
          if (win) {
            next.delete(windowId);
            changed = true;
          }
        }
      }
      if (changed) this._optimisticWindowNames = next;
    }
  }

  /** Returns the character-cell dimensions for a surface.
   *  Returns a fixed default until xterm reports real CSS cell dimensions. */
  private _cellMetricsFor(_surfaceId: string): CellMetrics | null {
    return { cellWidth: 8, cellHeight: 16 };
  }

  private _renderRegion(region: Region) {
    // All windows for this session — shown in the per-region tab strip.
    const sessionWindows = this._sessionWindows(region.surface.sessionName);
    // Apply any pending optimistic renames so the tab label updates instantly.
    const windowsForDisplay = sessionWindows.map((w) =>
      this._optimisticWindowNames.has(w.id)
        ? { ...w, name: this._optimisticWindowNames.get(w.id)! }
        : w
    );
    // The active (focused) window for this session — used for BOTH the tab highlight
    // AND the layout/pane content rendered in the body. Computing this FIRST ensures
    // that clicking a tab updates the displayed terminal, not just the active indicator.
    const sessionActiveWindowId = this._sessionActiveWindowId(region.surface.sessionName);
    const win = this._findWindow(region.surface.sessionName, sessionActiveWindowId);
    const windowName = win?.name ?? '';
    const layoutString = win?.layout ?? '';
    const activePaneId = win?.panes.find((p) => p.active)?.id ?? -1;

    // Session list for the inline session-dropdown inside the tab strip.
    const sessions: SessionInfo[] = (this.tmuxState?.sessions ?? []).map((s) => ({
      name: s.name,
      windows: s.windows.length,
    }));
    const activeSession = this.tmuxState?.activeSession ?? '';

    return html`
      <div class="region-slot" style="flex: ${region.weight}">
        <mux-region
          .regionId="${region.id}"
          .surfaceId="${region.surface.id}"
          .sessionName="${region.surface.sessionName}"
          .windowName="${windowName}"
          .layoutString="${layoutString}"
          .activePaneId="${activePaneId}"
          .windows="${windowsForDisplay}"
          .activeWindowId="${sessionActiveWindowId}"
          .sessions="${sessions}"
          .activeSession="${activeSession}"
          .isOnlyRegion="${this.workspace.regions.length === 1}"
          @tab-select="${(e: CustomEvent<{ windowId: number }>) => {
            // Optimistically record the desired window so content switches instantly.
            // Do NOT stopPropagation — let it continue up to app.ts for the server call.
            this._optimisticWindows = new Map(
              this._optimisticWindows.set(region.surface.sessionName, e.detail.windowId)
            );
          }}"
          @region-action="${(e: Event) => {
            e.stopPropagation();
            const ev = e as CustomEvent<{ action: RegionAction }>;
            this._handleRegionAction(region.id, ev.detail.action, activePaneId);
          }}"
        ></mux-region>
      </div>
    `;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('region-maximize', this._onMaximize);
    this.addEventListener('region-resize-drag', this._onResizeDrag);
    this.addEventListener('region-resize-end', this._onResizeEnd);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('region-maximize', this._onMaximize);
    this.removeEventListener('region-resize-drag', this._onResizeDrag);
    this.removeEventListener('region-resize-end', this._onResizeEnd);
    this._budget.dispose();
    this._coalescer.dispose();
    this._popoutManager.dispose();
  }

  render() {
    if (!this.workspace) return html``;

    const regions = this.workspace.visibleRegions;

    const items: Item[] = [];
    for (let i = 0; i < regions.length; i++) {
      items.push({ type: 'region', region: regions[i] });
      if (i < regions.length - 1) {
        items.push({ type: 'divider', idx: i });
      }
    }

    return html`${repeat(
      items,
      (item) => (item.type === 'region' ? item.region.id : `divider-${item.idx}`),
      (item) =>
        item.type === 'region'
          ? this._renderRegion(item.region)
          : html`<mux-region-divider></mux-region-divider>`,
    )}`;
  }

  /** @internal test hook — drive the cell-budget entry point directly. */
  measureSurfaceForTest(surfaceId: string, box: PixelBox, metrics: CellMetrics): void {
    this._budget.setSurfaceMetrics(surfaceId, metrics);
    this._budget.setSurfacePixelBox(surfaceId, box);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-workspace': MuxWorkspace;
  }
}
