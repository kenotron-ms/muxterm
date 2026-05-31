import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { Workspace, Region } from '../lib/workspace.js';
import type { TmuxState, Window } from '../types.js';
import './region.js';
import './region-divider.js';

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

  private _findWindow(sessionName: string, windowId: number): Window | undefined {
    const session = this.tmuxState?.sessions.find((s) => s.name === sessionName);
    return session?.windows.find((w) => w.id === windowId);
  }

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
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('region-maximize', this._onMaximize);
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
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-workspace': MuxWorkspace;
  }
}
