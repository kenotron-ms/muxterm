import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { Workspace, Region } from '../lib/workspace.js';
import type { TmuxState, Window } from '../types.js';
import { CellBudgetManager } from '../lib/cell-budget.js';
import { ResizeCoalescer } from '../lib/resize-coalescer.js';
import type { CellMetrics, PixelBox } from '../lib/cell-budget.js';
import './region.js';
import './region-divider.js';
import type { MuxRegion } from './region.js';

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

  protected override updated(): void {
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
  }

  /** Returns the character-cell dimensions for a surface.
   *  Returns a fixed default until xterm reports real CSS cell dimensions. */
  private _cellMetricsFor(_surfaceId: string): CellMetrics | null {
    return { cellWidth: 8, cellHeight: 16 };
  }

  private _renderRegion(region: Region) {
    const win = this._findWindow(region.surface.sessionName, region.surface.windowId);
    const windowName = win?.name ?? '';
    const layoutString = win?.layout ?? '';
    const activePaneId = win?.panes.find((p) => p.active)?.id ?? -1;

    return html`
      <div class="region-slot" style="flex: ${region.weight}">
        <mux-region
          .regionId=${region.id}
          .surfaceId=${region.surface.id}
          .sessionName=${region.surface.sessionName}
          .windowName=${windowName}
          .layoutString=${layoutString}
          .activePaneId=${activePaneId}
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
