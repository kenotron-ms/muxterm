// Mock ghostty-web for testing
// This file is aliased as 'ghostty-web' in vite.config.ts

export async function init(): Promise<void> {
  // async noop
}

export class Terminal {
  cols: number = 80;
  rows: number = 24;
  element: HTMLElement | null = null;

  _onDataCbs: Array<(data: string) => void> = [];
  _onResizeCbs: Array<(size: { cols: number; rows: number }) => void> = [];
  _writtenData: Uint8Array[] = [];

  open(container: HTMLElement): void {
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    this.element = container;
  }

  write(data: Uint8Array | string): void {
    if (typeof data === 'string') {
      this._writtenData.push(new TextEncoder().encode(data));
    } else {
      this._writtenData.push(data);
    }
  }

  onData(cb: (data: string) => void): void {
    this._onDataCbs.push(cb);
  }

  onResize(cb: (size: { cols: number; rows: number }) => void): void {
    this._onResizeCbs.push(cb);
  }

  loadAddon(_addon: unknown): void {
    // noop
  }

  dispose(): void {
    this._onDataCbs = [];
    this._onResizeCbs = [];
    this._writtenData = [];
    this.element = null;
  }

  focus(): void {
    // noop
  }

  reset(): void {
    this._writtenData = [];
  }

  clear(): void {
    this._writtenData = [];
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  // Test helpers
  getWrittenData(): Uint8Array[] {
    return this._writtenData;
  }

  simulateInput(data: string): void {
    for (const cb of this._onDataCbs) {
      cb(data);
    }
  }
}

export class FitAddon {
  fit(): void {
    // noop
  }

  observeResize(): void {
    // noop
  }

  proposeDimensions(): { cols: number; rows: number } | undefined {
    return { cols: 80, rows: 24 };
  }

  activate(_terminal: Terminal): void {
    // noop
  }

  dispose(): void {
    // noop
  }
}