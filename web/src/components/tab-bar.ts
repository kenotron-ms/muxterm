import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Window } from '../types.js';

@customElement('mux-tab-bar')
export class MuxTabBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      background: #16161e;
      border-bottom: 1px solid #292e42;
      height: 36px;
      padding: 0 8px;
      gap: 2px;
      user-select: none;
      flex-shrink: 0;
    }

    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 6px 6px 0 0;
      cursor: pointer;
      font-size: 13px;
      color: #565f89;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
    }

    .tab:hover {
      color: #a9b1d6;
      background: #1a1b26;
    }

    .tab.active {
      color: #c0caf5;
      background: #1a1b26;
      border-bottom: 2px solid #7aa2f7;
    }

    .tab-close {
      display: none;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
    }

    .tab:hover .tab-close {
      display: inline;
    }

    .tab-close:hover {
      color: #f7768e;
    }

    .tab-add {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      font-size: 18px;
      color: #565f89;
      background: transparent;
      border: none;
      cursor: pointer;
    }

    /* Ghost tab shown immediately on + click, before the real window arrives. */
    .tab.pending {
      color: #565f89;
      background: #1a1b26;
      cursor: default;
      opacity: 0.8;
    }

    .pending-label {
      font-style: italic;
    }

    .spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid #414868;
      border-top-color: #7aa2f7;
      border-radius: 50%;
      animation: tab-spin 0.6s linear infinite;
    }

    @keyframes tab-spin {
      to {
        transform: rotate(360deg);
      }
    }

    .spacer {
      flex: 1;
    }

    .title {
      color: #565f89;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
  `;

  @property({ attribute: false })
  windows: Window[] = [];

  @property({ type: String, attribute: 'active-window-id' })
  activeWindowId = '';

  // Optimistic UI: number of windows we've requested but haven't seen arrive.
  // Each renders as a ghost tab with a spinner so clicking + feels instant,
  // even though tmux + shell startup takes a few hundred ms.
  @state()
  private _pendingCount = 0;

  // Optimistic UI: window ids we've asked to close. Hidden from the tab list
  // immediately so delete feels instant, then confirmed gone by the next
  // authoritative state push. A safety timer un-hides them if the close
  // somehow didn't take effect (rare), so a tab can never vanish permanently.
  @state()
  private _closingIds = new Set<number>();

  private _closeTimers = new Map<number, ReturnType<typeof setTimeout>>();

  updated(changed: Map<string, unknown>): void {
    if (!changed.has('windows')) return;

    // Retire ghost "opening…" tabs as real windows arrive.
    if (this._pendingCount > 0) {
      const prev = (changed.get('windows') as Window[] | undefined)?.length ?? 0;
      const added = this.windows.length - prev;
      if (added > 0) {
        this._pendingCount = Math.max(0, this._pendingCount - added);
      }
    }

    // Clean up optimistic-close entries for windows tmux has confirmed gone.
    if (this._closingIds.size > 0) {
      const liveIds = new Set(this.windows.map((w) => w.id));
      let changedSet = false;
      for (const id of this._closingIds) {
        if (!liveIds.has(id)) {
          this._closingIds.delete(id);
          const t = this._closeTimers.get(id);
          if (t) {
            clearTimeout(t);
            this._closeTimers.delete(id);
          }
          changedSet = true;
        }
      }
      if (changedSet) this.requestUpdate();
    }
  }

  private _selectWindow(windowId: number): void {
    this.dispatchEvent(
      new CustomEvent('tab-select', {
        bubbles: true,
        composed: true,
        detail: { windowId },
      }),
    );
  }

  private _closeWindow(e: Event, windowId: number): void {
    e.stopPropagation();

    // Optimistically hide the tab NOW so delete feels instant.
    this._closingIds = new Set(this._closingIds).add(windowId);

    // Safety net: if tmux hasn't removed the window within 3s (close failed),
    // un-hide it so a tab can never disappear permanently.
    const t = setTimeout(() => {
      if (this._closingIds.has(windowId)) {
        const next = new Set(this._closingIds);
        next.delete(windowId);
        this._closingIds = next;
        this._closeTimers.delete(windowId);
      }
    }, 3000);
    this._closeTimers.set(windowId, t);

    this.dispatchEvent(
      new CustomEvent('tab-close', {
        bubbles: true,
        composed: true,
        detail: { windowId },
      }),
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const t of this._closeTimers.values()) clearTimeout(t);
    this._closeTimers.clear();
  }

  private _newWindow(): void {
    // Optimistic feedback: show a ghost tab immediately. tmux creates the
    // window in ~10ms but the shell takes a few hundred ms to draw its prompt,
    // so without this the + click feels dead until the real tab arrives.
    this._pendingCount++;
    this.dispatchEvent(
      new CustomEvent('tab-new', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <span class="title">muxterm</span>
      ${this.windows.map(
        (w) => html`
          <button
            class="tab ${String(w.id) === this.activeWindowId ? 'active' : ''}"
            @click="${() => this._selectWindow(w.id)}"
          >
            ${w.name}
            <span class="tab-close" @click="${(e: Event) => this._closeWindow(e, w.id)}">&times;</span>
          </button>
        `,
      )}
      ${Array.from({ length: this._pendingCount }).map(
        () => html`
          <button class="tab pending" disabled>
            <span class="spinner"></span>
            <span class="pending-label">opening…</span>
          </button>
        `,
      )}
      <button class="tab-add" @click="${this._newWindow}">+</button>
      <div class="spacer"></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-tab-bar': MuxTabBar;
  }
}