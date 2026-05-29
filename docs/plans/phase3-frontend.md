# Phase 3: Frontend — Lit + ghostty-web Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Build the complete Lit web component frontend that renders tmux state as native DOM elements — tabs, panes with ghostty-web terminals, layout splits, status bar — connected to the Go server via WebSocket.

**Architecture:** Vite + TypeScript + Lit web components. Each tmux concept maps to a component: windows are `<mux-tab-bar>` tabs, panes are `<mux-pane>` ghostty-web canvases, layout is `<mux-layout>` CSS flex splits, status is `<mux-status-bar>`. A reactive state store (`MuxStore`) receives WebSocket control messages (JSON text frames) and triggers Lit component re-renders. Binary pane I/O (4-byte LE uint32 pane ID + raw bytes) flows directly between ghostty-web Terminal instances and the WebSocket with zero JSON overhead.

**Tech Stack:** Vite 6, TypeScript 5.5, Lit 3, ghostty-web 0.3, Vitest 3 (happy-dom)

**Assumes:** Phase 1 (Go tmux control mode engine) and Phase 2 (WebSocket server with binary/text frame routing) are complete. The Go server serves the frontend from `web/dist/` via `embed.FS` and handles WebSocket connections at `/ws`.

---

## File Map

```
web/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
└── src/
    ├── types.ts                           # All TypeScript interfaces
    ├── lib/
    │   └── layout-parser.ts               # tmux layout string parser (pure function)
    ├── state.ts                           # Reactive MuxStore
    ├── ws.ts                              # WebSocket client
    ├── app.ts                             # <mux-app> root component
    ├── components/
    │   ├── tab-bar.ts                     # <mux-tab-bar>
    │   ├── layout.ts                      # <mux-layout> CSS flex renderer
    │   ├── pane.ts                        # <mux-pane> ghostty-web wrapper
    │   ├── status-bar.ts                  # <mux-status-bar>
    │   └── resize-handle.ts              # <mux-resize-handle>
    └── __tests__/
        ├── setup.ts                       # Test setup (ghostty-web mock)
        ├── layout-parser.test.ts          # Layout parser unit tests
        ├── state.test.ts                  # State store unit tests
        ├── ws.test.ts                     # WebSocket client unit tests
        └── tab-bar.test.ts               # Tab bar component tests
```

---

### Task 1: Frontend Scaffolding

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/index.html`
- Create: `web/src/types.ts`
- Create: `web/src/__tests__/setup.ts`

**Step 1: Create `web/package.json`**

```json
{
  "name": "muxterm-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "lit": "^3.2.0",
    "ghostty-web": "^0.3.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0",
    "happy-dom": "^15.0.0"
  }
}
```

**Step 2: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "useDefineForClassFields": false,
    "experimentalDecorators": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

Notes for `tsconfig.json`:
- `useDefineForClassFields: false` is required for Lit decorators (`@property`, `@state`) to work correctly.
- `experimentalDecorators: true` enables the `@customElement` decorator pattern.

**Step 3: Create `web/vite.config.ts`**

```typescript
/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2021',
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    alias: {
      'ghostty-web': resolve(__dirname, 'src/__tests__/setup.ts'),
    },
  },
});
```

**Step 4: Create `web/src/__tests__/setup.ts`**

This mock replaces ghostty-web in all test files. ghostty-web requires WASM + Canvas which don't exist in happy-dom.

```typescript
// Mock ghostty-web for Vitest (no WASM/Canvas in happy-dom)

export async function init(): Promise<void> {}

export class Terminal {
  cols = 80;
  rows = 24;
  element: HTMLElement | null = null;

  private _onDataCbs: Array<(data: string) => void> = [];
  private _onResizeCbs: Array<(size: { cols: number; rows: number }) => void> = [];
  private _writtenData: Array<string | Uint8Array> = [];

  open(container: HTMLElement): void {
    this.element = container;
    // Create a mock canvas element like the real terminal would
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
  }

  write(data: string | Uint8Array): void {
    this._writtenData.push(data);
  }

  onData(cb: (data: string) => void): { dispose: () => void } {
    this._onDataCbs.push(cb);
    return { dispose: () => { this._onDataCbs = this._onDataCbs.filter(c => c !== cb); } };
  }

  onResize(cb: (size: { cols: number; rows: number }) => void): { dispose: () => void } {
    this._onResizeCbs.push(cb);
    return { dispose: () => { this._onResizeCbs = this._onResizeCbs.filter(c => c !== cb); } };
  }

  loadAddon(_addon: unknown): void {}
  dispose(): void {}
  focus(): void {}
  reset(): void {}
  clear(): void {}
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this._onResizeCbs.forEach(cb => cb({ cols, rows }));
  }

  // Test helpers
  getWrittenData(): Array<string | Uint8Array> { return this._writtenData; }
  simulateInput(data: string): void { this._onDataCbs.forEach(cb => cb(data)); }
}

export class FitAddon {
  fit(): void {}
  observeResize(): void {}
  proposeDimensions(): { cols: number; rows: number } | undefined { return { cols: 80, rows: 24 }; }
  activate(_terminal: unknown): void {}
  dispose(): void {}
}
```

**Step 5: Create `web/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>muxterm</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      height: 100%;
      overflow: hidden;
      background: #1a1b26;
      color: #a9b1d6;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
  </style>
</head>
<body>
  <mux-app></mux-app>
  <script type="module" src="/src/app.ts"></script>
</body>
</html>
```

**Step 6: Create `web/src/types.ts`**

```typescript
// ============================================================================
// State model (mirrors Go TmuxState from internal/tmux/model.go)
// ============================================================================

export interface Pane {
  id: string;      // %N (e.g. "%5")
  width: number;
  height: number;
  active: boolean;
}

export interface Window {
  id: string;      // @N (e.g. "@3")
  name: string;
  panes: Pane[];
  layout: string;  // raw tmux layout string
}

export interface Session {
  name: string;
  windows: Window[];
}

export interface TmuxState {
  sessions: Session[];
  activeSession: string;
  activeWindow: string;
  activePane: string;
}

// ============================================================================
// Layout parser types
// ============================================================================

export type SplitDirection = 'horizontal' | 'vertical';

export interface LayoutLeaf {
  type: 'leaf';
  paneId: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface LayoutSplit {
  type: 'split';
  direction: SplitDirection;
  width: number;
  height: number;
  x: number;
  y: number;
  children: LayoutNode[];
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

// ============================================================================
// WebSocket protocol messages
// ============================================================================

// Server -> Client (text frames)
export type ServerMessage =
  | { type: 'state'; data: TmuxState }
  | { type: 'window-add'; data: { id: string; name: string } }
  | { type: 'window-renamed'; data: { id: string; name: string } }
  | { type: 'window-close'; data: { id: string } }
  | { type: 'layout-change'; data: { window: string; layout: string } }
  | { type: 'session-changed'; data: { name: string } }
  | { type: 'session-window-changed'; data: { session: string; window: string } }
  | { type: 'pane-mode'; data: { id: string; mode: string } }
  | { type: 'detached'; data: { reason: string } }
  | { type: 'error'; data: string };

// Client -> Server (text frames)
export type ClientMessage =
  | { type: 'select-window'; data: string }
  | { type: 'select-pane'; data: string }
  | { type: 'split'; data: { direction: 'horizontal' | 'vertical'; pane: string } }
  | { type: 'resize-pane'; data: { id: string; cols: number; rows: number } }
  | { type: 'new-window' }
  | { type: 'close-pane'; data: string }
  | { type: 'rename-window'; data: { id: string; name: string } }
  | { type: 'create-session'; data: { name: string } };

// ============================================================================
// Store event types
// ============================================================================

export interface MuxStoreEvents {
  change: TmuxState;
  'pane-output': { paneId: number; data: Uint8Array };
  disconnected: void;
  reconnecting: void;
  connected: void;
}
```

**Step 7: Install dependencies**

Run: `cd ~/workspace/muxterm/web && npm install`
Expected: `node_modules/` created, `package-lock.json` generated, 0 vulnerabilities

**Step 8: Verify dev server starts**

Run: `cd ~/workspace/muxterm/web && timeout 5 npx vite --port 5173 || true`
Expected: Output includes `Local: http://localhost:5173/`

**Step 9: Verify tests run (should pass — no test files yet)**

Run: `cd ~/workspace/muxterm/web && npx vitest run`
Expected: "No test files found" (or 0 tests passed — both are OK at this point)

**Step 10: Commit**

```bash
cd ~/workspace/muxterm && git add web/ && git commit -m "feat(web): scaffold frontend — Vite + Lit + ghostty-web + Vitest"
```

---

### Task 2: Layout Parser

The layout parser is a pure function with zero dependencies. Full TDD.

**Files:**
- Create: `web/src/lib/layout-parser.ts`
- Create: `web/src/__tests__/layout-parser.test.ts`

**Step 1: Write failing tests**

Create `web/src/__tests__/layout-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseLayout } from '../lib/layout-parser.js';
import type { LayoutLeaf, LayoutSplit } from '../types.js';

describe('parseLayout', () => {
  it('parses a single pane layout', () => {
    const result = parseLayout('bb62,159x48,0,0,1');
    expect(result).toEqual({
      type: 'leaf',
      paneId: 1,
      width: 159,
      height: 48,
      x: 0,
      y: 0,
    } satisfies LayoutLeaf);
  });

  it('parses a horizontal split (side by side)', () => {
    // {} = children arranged horizontally (left to right)
    const result = parseLayout('bb62,159x48,0,0{79x48,0,0,1,79x48,80,0,2}');
    const split = result as LayoutSplit;
    expect(split.type).toBe('split');
    expect(split.direction).toBe('horizontal');
    expect(split.width).toBe(159);
    expect(split.height).toBe(48);
    expect(split.children).toHaveLength(2);
    expect(split.children[0]).toEqual({
      type: 'leaf', paneId: 1, width: 79, height: 48, x: 0, y: 0,
    });
    expect(split.children[1]).toEqual({
      type: 'leaf', paneId: 2, width: 79, height: 48, x: 80, y: 0,
    });
  });

  it('parses a vertical split (stacked)', () => {
    // [] = children arranged vertically (top to bottom)
    const result = parseLayout('bb62,159x48,0,0[159x24,0,0,1,159x23,0,25,2]');
    const split = result as LayoutSplit;
    expect(split.type).toBe('split');
    expect(split.direction).toBe('vertical');
    expect(split.children).toHaveLength(2);
    expect(split.children[0]).toEqual({
      type: 'leaf', paneId: 1, width: 159, height: 24, x: 0, y: 0,
    });
    expect(split.children[1]).toEqual({
      type: 'leaf', paneId: 2, width: 159, height: 23, x: 0, y: 25,
    });
  });

  it('parses nested splits (horizontal with vertical right)', () => {
    // Left pane | [top right / bottom right]
    const result = parseLayout(
      'd0e0,159x48,0,0{79x48,0,0,1,79x48,80,0[79x24,80,0,2,79x23,80,25,3]}'
    );
    const root = result as LayoutSplit;
    expect(root.type).toBe('split');
    expect(root.direction).toBe('horizontal');
    expect(root.children).toHaveLength(2);

    // Left child is a leaf
    expect(root.children[0]).toEqual({
      type: 'leaf', paneId: 1, width: 79, height: 48, x: 0, y: 0,
    });

    // Right child is a vertical split
    const right = root.children[1] as LayoutSplit;
    expect(right.type).toBe('split');
    expect(right.direction).toBe('vertical');
    expect(right.children).toHaveLength(2);
    expect(right.children[0]).toEqual({
      type: 'leaf', paneId: 2, width: 79, height: 24, x: 80, y: 0,
    });
    expect(right.children[1]).toEqual({
      type: 'leaf', paneId: 3, width: 79, height: 23, x: 80, y: 25,
    });
  });

  it('parses a three-way horizontal split', () => {
    const result = parseLayout(
      'xxxx,240x48,0,0{80x48,0,0,1,80x48,81,0,2,78x48,162,0,3}'
    );
    const split = result as LayoutSplit;
    expect(split.type).toBe('split');
    expect(split.direction).toBe('horizontal');
    expect(split.children).toHaveLength(3);
    expect((split.children[0] as LayoutLeaf).paneId).toBe(1);
    expect((split.children[1] as LayoutLeaf).paneId).toBe(2);
    expect((split.children[2] as LayoutLeaf).paneId).toBe(3);
  });

  it('throws on empty string', () => {
    expect(() => parseLayout('')).toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm/web && npx vitest run src/__tests__/layout-parser.test.ts`
Expected: FAIL — Cannot find module `../lib/layout-parser.js`

**Step 3: Implement layout parser**

Create `web/src/lib/layout-parser.ts`:

```typescript
import type { LayoutNode, LayoutLeaf, LayoutSplit } from '../types.js';

/**
 * Parse a tmux layout string into a tree of LayoutNode objects.
 *
 * tmux layout format: `checksum,WxH,X,Y...`
 * - `{child1,child2,...}` = horizontal split (children side by side)
 * - `[child1,child2,...]` = vertical split (children stacked)
 * - Leaf: `WxH,X,Y,PaneID`
 *
 * Examples:
 *   Single pane:   "bb62,159x48,0,0,1"
 *   H-split:       "bb62,159x48,0,0{79x48,0,0,1,79x48,80,0,2}"
 *   Nested:        "d0e0,159x48,0,0{79x48,0,0,1,79x48,80,0[79x24,80,0,2,79x23,80,25,3]}"
 */
export function parseLayout(layout: string): LayoutNode {
  const firstComma = layout.indexOf(',');
  if (firstComma === -1) {
    throw new Error(`Invalid layout string: no comma found in "${layout}"`);
  }
  // Everything after the checksum
  const body = layout.slice(firstComma + 1);
  const [node] = parseNode(body, 0);
  return node;
}

function parseNode(s: string, pos: number): [LayoutNode, number] {
  const [width, height, x, y, nextPos] = parseDimensions(s, pos);

  if (nextPos >= s.length) {
    throw new Error(`Unexpected end of layout at position ${nextPos}`);
  }

  const ch = s[nextPos];

  // Split node: { = horizontal, [ = vertical
  if (ch === '{' || ch === '[') {
    const direction = ch === '{' ? 'horizontal' : 'vertical';
    const closeBracket = ch === '{' ? '}' : ']';
    const children: LayoutNode[] = [];
    let i = nextPos + 1;

    while (i < s.length && s[i] !== closeBracket) {
      const [child, childEnd] = parseNode(s, i);
      children.push(child);
      i = childEnd;
      if (i < s.length && s[i] === ',') {
        i++; // skip separator between children
      }
    }

    if (i < s.length && s[i] === closeBracket) {
      i++; // skip closing bracket
    }

    const split: LayoutSplit = { type: 'split', direction, width, height, x, y, children };
    return [split, i];
  }

  // Leaf node: comma then pane ID
  if (ch === ',') {
    const paneStart = nextPos + 1;
    let paneEnd = paneStart;
    while (paneEnd < s.length && isDigit(s[paneEnd])) {
      paneEnd++;
    }
    const paneId = parseInt(s.slice(paneStart, paneEnd), 10);
    const leaf: LayoutLeaf = { type: 'leaf', paneId, width, height, x, y };
    return [leaf, paneEnd];
  }

  throw new Error(`Unexpected character '${ch}' at position ${nextPos}`);
}

/**
 * Parse "WxH,X,Y" starting at `pos`. Returns [width, height, x, y, nextPos].
 */
function parseDimensions(s: string, pos: number): [number, number, number, number, number] {
  let i = pos;

  // W (digits until 'x')
  while (i < s.length && s[i] !== 'x') i++;
  const width = parseInt(s.slice(pos, i), 10);
  i++; // skip 'x'

  // H (digits until ',')
  const hStart = i;
  while (i < s.length && s[i] !== ',') i++;
  const height = parseInt(s.slice(hStart, i), 10);
  i++; // skip ','

  // X (digits until ',')
  const xStart = i;
  while (i < s.length && s[i] !== ',') i++;
  const x = parseInt(s.slice(xStart, i), 10);
  i++; // skip ','

  // Y (digits until end/comma/bracket)
  const yStart = i;
  while (i < s.length && isDigit(s[i])) i++;
  const y = parseInt(s.slice(yStart, i), 10);

  return [width, height, x, y, i];
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm/web && npx vitest run src/__tests__/layout-parser.test.ts`
Expected: 6 tests PASS

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add web/ && git commit -m "feat(web): tmux layout string parser with tests"
```

---

### Task 3: State Store

Reactive store that holds `TmuxState` and applies incremental updates from WebSocket messages. Lit components subscribe via callbacks and call `requestUpdate()`.

**Files:**
- Create: `web/src/state.ts`
- Create: `web/src/__tests__/state.test.ts`

**Step 1: Write failing tests**

Create `web/src/__tests__/state.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MuxStore, createInitialState } from '../state.js';
import type { TmuxState } from '../types.js';

describe('MuxStore', () => {
  it('starts with empty initial state', () => {
    const store = new MuxStore();
    expect(store.state.sessions).toEqual([]);
    expect(store.state.activeSession).toBe('');
    expect(store.state.activeWindow).toBe('');
    expect(store.state.activePane).toBe('');
  });

  it('applies full state sync', () => {
    const store = new MuxStore();
    const fullState: TmuxState = {
      sessions: [{ name: 'dev', windows: [{ id: '@1', name: 'vim', panes: [{ id: '%1', width: 80, height: 24, active: true }], layout: 'xxxx,80x24,0,0,1' }] }],
      activeSession: 'dev',
      activeWindow: '@1',
      activePane: '%1',
    };
    store.applyMessage({ type: 'state', data: fullState });
    expect(store.state).toEqual(fullState);
  });

  it('notifies subscribers on state change', () => {
    const store = new MuxStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.applyMessage({
      type: 'state',
      data: createInitialState(),
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const store = new MuxStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    unsub();

    store.applyMessage({ type: 'state', data: createInitialState() });
    expect(listener).not.toHaveBeenCalled();
  });

  it('applies window-add to active session', () => {
    const store = new MuxStore();
    store.applyMessage({
      type: 'state',
      data: {
        sessions: [{ name: 'dev', windows: [] }],
        activeSession: 'dev',
        activeWindow: '',
        activePane: '',
      },
    });

    store.applyMessage({ type: 'window-add', data: { id: '@2', name: 'build' } });

    const session = store.state.sessions.find(s => s.name === 'dev');
    expect(session?.windows).toHaveLength(1);
    expect(session?.windows[0].id).toBe('@2');
    expect(session?.windows[0].name).toBe('build');
  });

  it('applies window-renamed', () => {
    const store = new MuxStore();
    store.applyMessage({
      type: 'state',
      data: {
        sessions: [{ name: 'dev', windows: [{ id: '@1', name: 'old', panes: [], layout: '' }] }],
        activeSession: 'dev',
        activeWindow: '@1',
        activePane: '',
      },
    });

    store.applyMessage({ type: 'window-renamed', data: { id: '@1', name: 'vim' } });
    const win = store.state.sessions[0].windows[0];
    expect(win.name).toBe('vim');
  });

  it('applies layout-change', () => {
    const store = new MuxStore();
    store.applyMessage({
      type: 'state',
      data: {
        sessions: [{ name: 'dev', windows: [{ id: '@1', name: 'vim', panes: [], layout: 'old' }] }],
        activeSession: 'dev',
        activeWindow: '@1',
        activePane: '',
      },
    });

    store.applyMessage({ type: 'layout-change', data: { window: '@1', layout: 'bb62,159x48,0,0{79x48,0,0,1,79x48,80,0,2}' } });
    const win = store.state.sessions[0].windows[0];
    expect(win.layout).toBe('bb62,159x48,0,0{79x48,0,0,1,79x48,80,0,2}');
  });

  it('applies session-window-changed', () => {
    const store = new MuxStore();
    store.applyMessage({
      type: 'state',
      data: {
        sessions: [{ name: 'dev', windows: [
          { id: '@1', name: 'vim', panes: [], layout: '' },
          { id: '@2', name: 'build', panes: [], layout: '' },
        ] }],
        activeSession: 'dev',
        activeWindow: '@1',
        activePane: '',
      },
    });

    store.applyMessage({ type: 'session-window-changed', data: { session: 'dev', window: '@2' } });
    expect(store.state.activeWindow).toBe('@2');
  });

  it('applies window-close', () => {
    const store = new MuxStore();
    store.applyMessage({
      type: 'state',
      data: {
        sessions: [{ name: 'dev', windows: [
          { id: '@1', name: 'vim', panes: [], layout: '' },
          { id: '@2', name: 'build', panes: [], layout: '' },
        ] }],
        activeSession: 'dev',
        activeWindow: '@1',
        activePane: '',
      },
    });

    store.applyMessage({ type: 'window-close', data: { id: '@2' } });
    expect(store.state.sessions[0].windows).toHaveLength(1);
    expect(store.state.sessions[0].windows[0].id).toBe('@1');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm/web && npx vitest run src/__tests__/state.test.ts`
Expected: FAIL — Cannot find module `../state.js`

**Step 3: Implement state store**

Create `web/src/state.ts`:

```typescript
import type { TmuxState, ServerMessage, Session, Window } from './types.js';

export function createInitialState(): TmuxState {
  return {
    sessions: [],
    activeSession: '',
    activeWindow: '',
    activePane: '',
  };
}

export class MuxStore {
  private _state: TmuxState = createInitialState();
  private _listeners = new Set<() => void>();

  get state(): TmuxState {
    return this._state;
  }

  subscribe(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  }

  applyMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'state':
        this._state = msg.data;
        break;

      case 'window-add': {
        const session = this._findActiveSession();
        if (session) {
          session.windows.push({
            id: msg.data.id,
            name: msg.data.name,
            panes: [],
            layout: '',
          });
        }
        break;
      }

      case 'window-renamed': {
        const win = this._findWindow(msg.data.id);
        if (win) win.name = msg.data.name;
        break;
      }

      case 'window-close': {
        const session = this._findActiveSession();
        if (session) {
          session.windows = session.windows.filter(w => w.id !== msg.data.id);
        }
        break;
      }

      case 'layout-change': {
        const win = this._findWindow(msg.data.window);
        if (win) win.layout = msg.data.layout;
        break;
      }

      case 'session-changed':
        this._state.activeSession = msg.data.name;
        break;

      case 'session-window-changed':
        this._state.activeWindow = msg.data.window;
        break;

      case 'pane-mode':
        // Future: track pane copy-mode state
        break;

      case 'detached':
        // Handled by ws.ts reconnect logic
        break;

      case 'error':
        console.warn('[muxterm] server error:', msg.data);
        return; // Don't notify on errors
    }

    this._notify();
  }

  private _findActiveSession(): Session | undefined {
    return this._state.sessions.find(s => s.name === this._state.activeSession);
  }

  private _findWindow(id: string): Window | undefined {
    for (const session of this._state.sessions) {
      const win = session.windows.find(w => w.id === id);
      if (win) return win;
    }
    return undefined;
  }

  private _notify(): void {
    this._listeners.forEach(cb => cb());
  }
}

/** Singleton store for the application */
export const store = new MuxStore();
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm/web && npx vitest run src/__tests__/state.test.ts`
Expected: 8 tests PASS

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add web/ && git commit -m "feat(web): reactive MuxStore with tests"
```

---

### Task 4: WebSocket Client

Connects to the Go server, routes binary frames to pane output callbacks, routes JSON text frames to the state store, sends binary frames for user input, sends JSON for control actions. Reconnects with exponential backoff.

**Files:**
- Create: `web/src/ws.ts`
- Create: `web/src/__tests__/ws.test.ts`

**Step 1: Write failing tests**

Create `web/src/__tests__/ws.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MuxSocket } from '../ws.js';
import { MuxStore } from '../state.js';

// Minimal WebSocket mock
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  url: string;

  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  sent: Array<string | ArrayBuffer> = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: string | ArrayBuffer): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

let lastCreatedWs: MockWebSocket | null = null;

beforeEach(() => {
  lastCreatedWs = null;
  (globalThis as any).WebSocket = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      lastCreatedWs = this;
    }
  };
});

afterEach(() => {
  delete (globalThis as any).WebSocket;
});

describe('MuxSocket', () => {
  it('connects to the correct URL', () => {
    const store = new MuxStore();
    const socket = new MuxSocket(store, 'ws://localhost:8080/ws');
    socket.connect();

    expect(lastCreatedWs).not.toBeNull();
    expect(lastCreatedWs!.url).toBe('ws://localhost:8080/ws');
    expect(lastCreatedWs!.binaryType).toBe('arraybuffer');
    socket.disconnect();
  });

  it('routes text frames to store.applyMessage', () => {
    const store = new MuxStore();
    const spy = vi.spyOn(store, 'applyMessage');
    const socket = new MuxSocket(store, 'ws://localhost:8080/ws');
    socket.connect();

    lastCreatedWs!.simulateOpen();
    lastCreatedWs!.simulateMessage(JSON.stringify({
      type: 'window-add',
      data: { id: '@3', name: 'vim' },
    }));

    expect(spy).toHaveBeenCalledWith({
      type: 'window-add',
      data: { id: '@3', name: 'vim' },
    });
    socket.disconnect();
  });

  it('routes binary frames to pane output callback', () => {
    const store = new MuxStore();
    const socket = new MuxSocket(store, 'ws://localhost:8080/ws');
    const outputCb = vi.fn();
    socket.onPaneOutput(outputCb);
    socket.connect();

    lastCreatedWs!.simulateOpen();

    // Binary frame: 4-byte LE uint32 pane ID (5) + "hello"
    const paneId = 5;
    const text = new TextEncoder().encode('hello');
    const frame = new ArrayBuffer(4 + text.length);
    const view = new DataView(frame);
    view.setUint32(0, paneId, true); // little-endian
    new Uint8Array(frame, 4).set(text);

    lastCreatedWs!.simulateMessage(frame);

    expect(outputCb).toHaveBeenCalledWith(paneId, expect.any(Uint8Array));
    const receivedData = outputCb.mock.calls[0][1] as Uint8Array;
    expect(new TextDecoder().decode(receivedData)).toBe('hello');
    socket.disconnect();
  });

  it('sends binary frames with pane ID prefix', () => {
    const store = new MuxStore();
    const socket = new MuxSocket(store, 'ws://localhost:8080/ws');
    socket.connect();
    lastCreatedWs!.simulateOpen();

    const input = new TextEncoder().encode('ls\n');
    socket.sendPaneInput(5, input);

    expect(lastCreatedWs!.sent).toHaveLength(1);
    const sent = new Uint8Array(lastCreatedWs!.sent[0] as ArrayBuffer);
    const view = new DataView(sent.buffer);
    expect(view.getUint32(0, true)).toBe(5);
    expect(new TextDecoder().decode(sent.slice(4))).toBe('ls\n');
    socket.disconnect();
  });

  it('sends JSON text frames for control messages', () => {
    const store = new MuxStore();
    const socket = new MuxSocket(store, 'ws://localhost:8080/ws');
    socket.connect();
    lastCreatedWs!.simulateOpen();

    socket.sendControl({ type: 'select-window', data: '@3' });

    expect(lastCreatedWs!.sent).toHaveLength(1);
    expect(JSON.parse(lastCreatedWs!.sent[0] as string)).toEqual({
      type: 'select-window',
      data: '@3',
    });
    socket.disconnect();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm/web && npx vitest run src/__tests__/ws.test.ts`
Expected: FAIL — Cannot find module `../ws.js`

**Step 3: Implement WebSocket client**

Create `web/src/ws.ts`:

```typescript
import type { MuxStore } from './state.js';
import type { ServerMessage, ClientMessage } from './types.js';

type PaneOutputCallback = (paneId: number, data: Uint8Array) => void;

export class MuxSocket {
  private _store: MuxStore;
  private _url: string;
  private _ws: WebSocket | null = null;
  private _paneOutputCb: PaneOutputCallback | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts = 0;
  private _intentionalClose = false;

  constructor(store: MuxStore, url: string) {
    this._store = store;
    this._url = url;
  }

  onPaneOutput(cb: PaneOutputCallback): void {
    this._paneOutputCb = cb;
  }

  connect(): void {
    this._intentionalClose = false;
    this._reconnectAttempts = 0;
    this._open();
  }

  disconnect(): void {
    this._intentionalClose = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  sendPaneInput(paneId: number, data: Uint8Array): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const frame = new ArrayBuffer(4 + data.length);
    const view = new DataView(frame);
    view.setUint32(0, paneId, true); // little-endian
    new Uint8Array(frame, 4).set(data);
    this._ws.send(frame);
  }

  sendControl(msg: ClientMessage): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify(msg));
  }

  get connected(): boolean {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  private _open(): void {
    const ws = new WebSocket(this._url);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      if (ws !== this._ws) return;
      this._reconnectAttempts = 0;
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (ws !== this._ws) return;

      if (ev.data instanceof ArrayBuffer) {
        // Binary frame: [paneId:4 bytes LE uint32][data:N bytes]
        const buf = ev.data;
        if (buf.byteLength < 4) return;
        const view = new DataView(buf);
        const paneId = view.getUint32(0, true);
        const data = new Uint8Array(buf, 4);
        this._paneOutputCb?.(paneId, data);
      } else if (typeof ev.data === 'string') {
        // Text frame: JSON control message
        try {
          const msg = JSON.parse(ev.data) as ServerMessage;
          this._store.applyMessage(msg);
        } catch {
          console.warn('[muxterm] invalid JSON from server:', ev.data);
        }
      }
    };

    ws.onclose = () => {
      if (ws !== this._ws) return;
      if (this._intentionalClose) return;

      // Exponential backoff: 1s, 2s, 4s, 8s, cap at 15s + jitter
      this._reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), 15000);
      const jitter = Math.random() * 500;
      this._reconnectTimer = setTimeout(() => this._open(), delay + jitter);
    };

    ws.onerror = () => {
      // The close event will fire after this, triggering reconnect
    };
  }
}

/**
 * Build a WebSocket URL from the current page location.
 * Handles http->ws and https->wss protocol conversion.
 */
export function buildWsUrl(path: string = '/ws'): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm/web && npx vitest run src/__tests__/ws.test.ts`
Expected: 5 tests PASS

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add web/ && git commit -m "feat(web): WebSocket client with binary/text routing and reconnect"
```

---

### Task 5: `<mux-pane>` Component

Wraps a single ghostty-web `Terminal` instance. Each tmux pane gets its own `<mux-pane>`. Receives terminal output via `writeData()`, fires `pane-input` events when user types. Handles fit-to-container and resize.

**Files:**
- Create: `web/src/components/pane.ts`

**Step 1: Implement `<mux-pane>`**

Create `web/src/components/pane.ts`:

```typescript
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// ghostty-web imports — actual implementation; mocked in tests via vitest alias
import { init, Terminal, FitAddon } from 'ghostty-web';

// Module-level WASM init promise (runs once, shared by all pane instances)
let ghosttyReady: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!ghosttyReady) {
    ghosttyReady = init();
  }
  return ghosttyReady;
}

/**
 * <mux-pane> — wraps a ghostty-web Terminal canvas.
 *
 * @attr pane-id - The tmux pane ID (numeric, e.g. 5 for %5)
 * @fires pane-input - User typed in the terminal. detail: { paneId: number, data: Uint8Array }
 * @fires pane-resize - Terminal resized. detail: { paneId: number, cols: number, rows: number }
 * @fires pane-focus - Pane received focus. detail: { paneId: number }
 */
@customElement('mux-pane')
export class MuxPane extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
      position: relative;
      background: #1a1b26;
    }
    #container {
      width: 100%;
      height: 100%;
    }
  `;

  @property({ type: Number, attribute: 'pane-id' })
  paneId = 0;

  @property({ type: Boolean, reflect: true })
  active = false;

  private _term: Terminal | null = null;
  private _fitAddon: FitAddon | null = null;
  private _encoder = new TextEncoder();
  private _disposables: Array<{ dispose: () => void }> = [];

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    await this.updateComplete;
    await ensureInit();
    this._initTerminal();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    if (this._fitAddon) {
      this._fitAddon.dispose();
      this._fitAddon = null;
    }
    if (this._term) {
      this._term.dispose();
      this._term = null;
    }
  }

  /** Write terminal output data (called by <mux-app> when binary frame arrives for this pane) */
  writeData(data: Uint8Array | string): void {
    this._term?.write(data);
  }

  /** Focus this pane's terminal */
  focusTerminal(): void {
    this._term?.focus();
  }

  private _initTerminal(): void {
    const container = this.shadowRoot?.getElementById('container');
    if (!container) return;

    this._term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, Consolas, monospace",
      theme: {
        background: '#1a1b26',
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
      },
      scrollback: 0, // Let tmux own scrolling (copy-mode)
    });

    this._fitAddon = new FitAddon();
    this._term.loadAddon(this._fitAddon);
    this._term.open(container);

    // Auto-fit when container resizes
    this._fitAddon.observeResize();

    // User input -> pane-input event
    const onData = this._term.onData((data: string) => {
      this.dispatchEvent(new CustomEvent('pane-input', {
        bubbles: true,
        composed: true,
        detail: { paneId: this.paneId, data: this._encoder.encode(data) },
      }));
    });
    this._disposables.push(onData);

    // Terminal resize -> pane-resize event
    const onResize = this._term.onResize((size: { cols: number; rows: number }) => {
      this.dispatchEvent(new CustomEvent('pane-resize', {
        bubbles: true,
        composed: true,
        detail: { paneId: this.paneId, cols: size.cols, rows: size.rows },
      }));
    });
    this._disposables.push(onResize);

    // Focus tracking
    container.addEventListener('mousedown', () => {
      this.dispatchEvent(new CustomEvent('pane-focus', {
        bubbles: true,
        composed: true,
        detail: { paneId: this.paneId },
      }));
    });
  }

  render() {
    return html`<div id="container" @click=${this._handleClick}></div>`;
  }

  private _handleClick(): void {
    this._term?.focus();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-pane': MuxPane;
  }
}
```

**Step 2: Verify the file type-checks**

Run: `cd ~/workspace/muxterm/web && npx tsc --noEmit`
Expected: No type errors (there may be warnings about unresolved ghostty-web if types aren't published — that's OK, `skipLibCheck: true` handles it)

**Step 3: Commit**

```bash
cd ~/workspace/muxterm && git add web/ && git commit -m "feat(web): <mux-pane> ghostty-web terminal wrapper"
```

---

### Task 6: `<mux-tab-bar>` Component

Renders tmux windows as clickable tabs. Shows active tab. "+" button creates a new window. Click fires `select-window` action.

**Files:**
- Create: `web/src/components/tab-bar.ts`
- Create: `web/src/__tests__/tab-bar.test.ts`

**Step 1: Write failing tests**

Create `web/src/__tests__/tab-bar.test.ts`:

```typescript
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Import Lit for fixture testing
import { html, LitElement } from 'lit';
import '../components/tab-bar.js';
import type { MuxTabBar } from '../components/tab-bar.js';
import type { Window } from '../types.js';

async function fixture(template: ReturnType<typeof html>): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const el = document.createElement('mux-tab-bar') as MuxTabBar;
  container.appendChild(el);
  // Wait for Lit to render
  await el.updateComplete;
  return el;
}

describe('mux-tab-bar', () => {
  it('renders tabs from windows array', async () => {
    const el = document.createElement('mux-tab-bar') as MuxTabBar;
    el.windows = [
      { id: '@1', name: 'vim', panes: [], layout: '' },
      { id: '@2', name: 'build', panes: [], layout: '' },
    ];
    el.activeWindowId = '@1';
    document.body.appendChild(el);
    await el.updateComplete;

    const tabs = el.shadowRoot!.querySelectorAll('.tab');
    expect(tabs.length).toBe(2);
    expect(tabs[0].textContent?.trim()).toBe('vim');
    expect(tabs[1].textContent?.trim()).toBe('build');

    el.remove();
  });

  it('marks the active tab', async () => {
    const el = document.createElement('mux-tab-bar') as MuxTabBar;
    el.windows = [
      { id: '@1', name: 'vim', panes: [], layout: '' },
      { id: '@2', name: 'build', panes: [], layout: '' },
    ];
    el.activeWindowId = '@2';
    document.body.appendChild(el);
    await el.updateComplete;

    const tabs = el.shadowRoot!.querySelectorAll('.tab');
    expect(tabs[0].classList.contains('active')).toBe(false);
    expect(tabs[1].classList.contains('active')).toBe(true);

    el.remove();
  });

  it('fires tab-select on click', async () => {
    const el = document.createElement('mux-tab-bar') as MuxTabBar;
    el.windows = [
      { id: '@1', name: 'vim', panes: [], layout: '' },
      { id: '@2', name: 'build', panes: [], layout: '' },
    ];
    el.activeWindowId = '@1';
    document.body.appendChild(el);
    await el.updateComplete;

    const handler = vi.fn();
    el.addEventListener('tab-select', handler);

    const tabs = el.shadowRoot!.querySelectorAll('.tab');
    (tabs[1] as HTMLElement).click();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail).toEqual({ windowId: '@2' });

    el.remove();
  });

  it('fires tab-new on + button click', async () => {
    const el = document.createElement('mux-tab-bar') as MuxTabBar;
    el.windows = [{ id: '@1', name: 'vim', panes: [], layout: '' }];
    el.activeWindowId = '@1';
    document.body.appendChild(el);
    await el.updateComplete;

    const handler = vi.fn();
    el.addEventListener('tab-new', handler);

    const addBtn = el.shadowRoot!.querySelector('.tab-add') as HTMLElement;
    addBtn.click();

    expect(handler).toHaveBeenCalledTimes(1);

    el.remove();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm/web && npx vitest run src/__tests__/tab-bar.test.ts`
Expected: FAIL — Cannot find module `../components/tab-bar.js`

**Step 3: Implement `<mux-tab-bar>`**

Create `web/src/components/tab-bar.ts`:

```typescript
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Window } from '../types.js';

/**
 * <mux-tab-bar> — renders tmux windows as clickable tabs.
 *
 * @attr windows - Array of Window objects
 * @attr activeWindowId - The currently active window ID
 * @fires tab-select - Tab clicked. detail: { windowId: string }
 * @fires tab-new - "+" button clicked.
 * @fires tab-close - Close button on tab clicked. detail: { windowId: string }
 */
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
      font-family: inherit;
      transition: color 0.15s, background 0.15s;
      white-space: nowrap;
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
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
      background: none;
      border: none;
      color: #565f89;
      cursor: pointer;
      font-size: 14px;
      padding: 0 2px;
      line-height: 1;
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
      border-radius: 6px;
      cursor: pointer;
      font-size: 18px;
      color: #565f89;
      background: none;
      border: none;
      font-family: inherit;
    }

    .tab-add:hover {
      color: #a9b1d6;
      background: #1a1b26;
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
      margin-right: 12px;
    }
  `;

  @property({ attribute: false })
  windows: Window[] = [];

  @property({ type: String, attribute: 'active-window-id' })
  activeWindowId = '';

  render() {
    return html`
      <span class="title">muxterm</span>
      ${this.windows.map(win => html`
        <button
          class="tab ${win.id === this.activeWindowId ? 'active' : ''}"
          @click=${() => this._selectWindow(win.id)}
        >
          ${win.name}
          <span class="tab-close" @click=${(e: Event) => this._closeWindow(e, win.id)}>&times;</span>
        </button>
      `)}
      <button class="tab-add" @click=${this._newWindow} title="New window">+</button>
      <span class="spacer"></span>
    `;
  }

  private _selectWindow(windowId: string): void {
    this.dispatchEvent(new CustomEvent('tab-select', {
      bubbles: true,
      composed: true,
      detail: { windowId },
    }));
  }

  private _closeWindow(e: Event, windowId: string): void {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('tab-close', {
      bubbles: true,
      composed: true,
      detail: { windowId },
    }));
  }

  private _newWindow(): void {
    this.dispatchEvent(new CustomEvent('tab-new', {
      bubbles: true,
      composed: true,
    }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-tab-bar': MuxTabBar;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm/web && npx vitest run src/__tests__/tab-bar.test.ts`
Expected: 4 tests PASS

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add web/ && git commit -m "feat(web): <mux-tab-bar> component with tests"
```

---

### Task 7: `<mux-layout>` Component

Parses a tmux layout string and renders as nested CSS flex containers. Each leaf node renders a `<mux-pane>` element. Horizontal splits are `flex-direction: row`, vertical splits are `flex-direction: column`.

**Files:**
- Create: `web/src/components/layout.ts`
- Create: `web/src/__tests__/layout-component.test.ts`

**Step 1: Write failing tests**

Create `web/src/__tests__/layout-component.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import '../components/layout.js';
import type { MuxLayout } from '../components/layout.js';

describe('mux-layout', () => {
  it('renders a single pane for a leaf layout', async () => {
    const el = document.createElement('mux-layout') as MuxLayout;
    el.layoutString = 'bb62,80x24,0,0,1';
    document.body.appendChild(el);
    await el.updateComplete;

    const pane = el.shadowRoot!.querySelector('mux-pane');
    expect(pane).not.toBeNull();
    expect(pane!.getAttribute('pane-id')).toBe('1');

    el.remove();
  });

  it('renders two panes for a horizontal split', async () => {
    const el = document.createElement('mux-layout') as MuxLayout;
    el.layoutString = 'bb62,159x48,0,0{79x48,0,0,1,79x48,80,0,2}';
    document.body.appendChild(el);
    await el.updateComplete;

    const panes = el.shadowRoot!.querySelectorAll('mux-pane');
    expect(panes.length).toBe(2);

    // Check the split container exists with row direction
    const splitContainer = el.shadowRoot!.querySelector('.split-h');
    expect(splitContainer).not.toBeNull();

    el.remove();
  });

  it('renders nested splits correctly', async () => {
    const el = document.createElement('mux-layout') as MuxLayout;
    // H-split: left pane | [top-right / bottom-right]
    el.layoutString = 'd0e0,159x48,0,0{79x48,0,0,1,79x48,80,0[79x24,80,0,2,79x23,80,25,3]}';
    document.body.appendChild(el);
    await el.updateComplete;

    const panes = el.shadowRoot!.querySelectorAll('mux-pane');
    expect(panes.length).toBe(3);

    // Root is horizontal split
    const hSplit = el.shadowRoot!.querySelector('.split-h');
    expect(hSplit).not.toBeNull();

    // Contains a vertical split
    const vSplit = el.shadowRoot!.querySelector('.split-v');
    expect(vSplit).not.toBeNull();

    el.remove();
  });

  it('shows placeholder when no layout string', async () => {
    const el = document.createElement('mux-layout') as MuxLayout;
    el.layoutString = '';
    document.body.appendChild(el);
    await el.updateComplete;

    const placeholder = el.shadowRoot!.querySelector('.empty');
    expect(placeholder).not.toBeNull();

    el.remove();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm/web && npx vitest run src/__tests__/layout-component.test.ts`
Expected: FAIL — Cannot find module `../components/layout.js`

**Step 3: Implement `<mux-layout>`**

Create `web/src/components/layout.ts`:

```typescript
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { parseLayout } from '../lib/layout-parser.js';
import type { LayoutNode, LayoutSplit, LayoutLeaf } from '../types.js';
import './pane.js';
import './resize-handle.js';

/**
 * <mux-layout> — renders tmux pane layout as nested CSS flex containers.
 *
 * Takes a raw tmux layout string and renders <mux-pane> elements in the
 * correct split arrangement using CSS flexbox.
 */
@customElement('mux-layout')
export class MuxLayout extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex: 1;
      overflow: hidden;
      background: #1a1b26;
    }

    .split-h {
      display: flex;
      flex-direction: row;
      width: 100%;
      height: 100%;
    }

    .split-v {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
    }

    .pane-wrapper {
      position: relative;
      overflow: hidden;
      min-width: 40px;
      min-height: 20px;
    }

    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      color: #565f89;
      font-size: 14px;
    }
  `;

  @property({ type: String, attribute: 'layout-string' })
  layoutString = '';

  @property({ type: Number, attribute: 'active-pane-id' })
  activePaneId = -1;

  render() {
    if (!this.layoutString) {
      return html`<div class="empty">No panes</div>`;
    }

    try {
      const tree = parseLayout(this.layoutString);
      return this._renderNode(tree);
    } catch (err) {
      console.warn('[mux-layout] Failed to parse layout:', err);
      return html`<div class="empty">Layout error</div>`;
    }
  }

  private _renderNode(node: LayoutNode): TemplateResult {
    if (node.type === 'leaf') {
      return this._renderLeaf(node);
    }
    return this._renderSplit(node);
  }

  private _renderSplit(node: LayoutSplit): TemplateResult {
    const dirClass = node.direction === 'horizontal' ? 'split-h' : 'split-v';

    // Calculate flex proportions from child dimensions
    const totalSize = node.direction === 'horizontal'
      ? node.children.reduce((sum, c) => sum + c.width, 0)
      : node.children.reduce((sum, c) => sum + c.height, 0);

    return html`
      <div class="${dirClass}">
        ${node.children.map((child, i) => {
          const childSize = node.direction === 'horizontal' ? child.width : child.height;
          const flex = totalSize > 0 ? childSize / totalSize : 1;
          const childHtml = html`
            <div class="pane-wrapper" style="flex: ${flex}">
              ${this._renderNode(child)}
            </div>
          `;
          // Insert resize handles between children (not after last)
          if (i < node.children.length - 1) {
            return html`${childHtml}<mux-resize-handle direction=${node.direction}></mux-resize-handle>`;
          }
          return childHtml;
        })}
      </div>
    `;
  }

  private _renderLeaf(node: LayoutLeaf): TemplateResult {
    return html`
      <mux-pane
        pane-id=${node.paneId}
        ?active=${node.paneId === this.activePaneId}
      ></mux-pane>
    `;
  }

  /** Get a <mux-pane> element by pane ID */
  getPaneElement(paneId: number): HTMLElement | null {
    return this.shadowRoot?.querySelector(`mux-pane[pane-id="${paneId}"]`) ?? null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-layout': MuxLayout;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm/web && npx vitest run src/__tests__/layout-component.test.ts`
Expected: 4 tests PASS

Note: If the test for `split-h` class fails, check that the `mux-resize-handle` import doesn't cause issues. If it does, create a minimal stub first (see Task 9) or adjust the import to be conditional.

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add web/ && git commit -m "feat(web): <mux-layout> CSS flex split renderer with tests"
```

---

### Task 8: `<mux-status-bar>` Component

Renders session name, window info, and pane info at the bottom. Simple display component.

**Files:**
- Create: `web/src/components/status-bar.ts`

**Step 1: Implement `<mux-status-bar>`**

Create `web/src/components/status-bar.ts`:

```typescript
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * <mux-status-bar> — renders tmux status information at the bottom.
 *
 * Shows session name, window/pane counts, and connection status.
 */
@customElement('mux-status-bar')
export class MuxStatusBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #16161e;
      border-top: 1px solid #292e42;
      height: 24px;
      padding: 0 12px;
      font-size: 12px;
      color: #565f89;
      flex-shrink: 0;
      user-select: none;
    }

    .left, .right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .session {
      color: #7aa2f7;
      font-weight: 600;
    }

    .separator {
      color: #292e42;
    }

    .connected {
      color: #9ece6a;
    }

    .disconnected {
      color: #f7768e;
    }

    .reconnecting {
      color: #e0af68;
    }
  `;

  @property({ type: String })
  sessionName = '';

  @property({ type: Number })
  windowCount = 0;

  @property({ type: Number })
  paneCount = 0;

  @property({ type: String })
  activeWindowName = '';

  @property({ type: String })
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

  render() {
    return html`
      <div class="left">
        <span class="session">[${this.sessionName || 'no session'}]</span>
        <span class="separator">|</span>
        <span>${this.windowCount} window${this.windowCount !== 1 ? 's' : ''}</span>
        <span class="separator">|</span>
        <span>${this.activeWindowName}: ${this.paneCount} pane${this.paneCount !== 1 ? 's' : ''}</span>
      </div>
      <div class="right">
        <span class="${this.connectionStatus}">
          ${this.connectionStatus === 'connected' ? 'connected' :
            this.connectionStatus === 'reconnecting' ? 'reconnecting...' :
            'disconnected'}
        </span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-status-bar': MuxStatusBar;
  }
}
```

**Step 2: Verify the file type-checks**

Run: `cd ~/workspace/muxterm/web && npx tsc --noEmit`
Expected: No type errors

**Step 3: Commit**

```bash
cd ~/workspace/muxterm && git add web/ && git commit -m "feat(web): <mux-status-bar> component"
```

---

### Task 9: `<mux-resize-handle>` Component

Draggable handle rendered between panes. On drag, fires a `pane-resize-drag` event with the pixel delta. The parent (`<mux-app>`) translates this to a `resize-pane` command sent to tmux. tmux recalculates the layout and sends back `%layout-change`, which re-renders everything.

**Files:**
- Create: `web/src/components/resize-handle.ts`

**Step 1: Implement `<mux-resize-handle>`**

Create `web/src/components/resize-handle.ts`:

```typescript
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * <mux-resize-handle> — draggable divider between panes.
 *
 * @attr direction - 'horizontal' (vertical bar between left/right) or 'vertical' (horizontal bar between top/bottom)
 * @fires resize-drag - Drag in progress. detail: { deltaX: number, deltaY: number }
 */
@customElement('mux-resize-handle')
export class MuxResizeHandle extends LitElement {
  static styles = css`
    :host {
      display: block;
      flex-shrink: 0;
    }

    :host([direction="horizontal"]) {
      width: 4px;
      cursor: col-resize;
    }

    :host([direction="vertical"]) {
      height: 4px;
      cursor: row-resize;
    }

    .handle {
      width: 100%;
      height: 100%;
      background: #292e42;
      transition: background 0.15s;
    }

    .handle:hover,
    .handle.dragging {
      background: #7aa2f7;
    }
  `;

  @property({ type: String, reflect: true })
  direction: 'horizontal' | 'vertical' = 'horizontal';

  private _dragging = false;
  private _startX = 0;
  private _startY = 0;

  render() {
    return html`
      <div
        class="handle ${this._dragging ? 'dragging' : ''}"
        @pointerdown=${this._onPointerDown}
      ></div>
    `;
  }

  private _onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    this._dragging = true;
    this._startX = e.clientX;
    this._startY = e.clientY;

    const handle = e.target as HTMLElement;
    handle.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!this._dragging) return;
      const deltaX = ev.clientX - this._startX;
      const deltaY = ev.clientY - this._startY;
      this.dispatchEvent(new CustomEvent('resize-drag', {
        bubbles: true,
        composed: true,
        detail: { deltaX, deltaY },
      }));
    };

    const onUp = () => {
      this._dragging = false;
      this.requestUpdate();
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    this.requestUpdate();
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-resize-handle': MuxResizeHandle;
  }
}
```

**Step 2: Verify the file type-checks**

Run: `cd ~/workspace/muxterm/web && npx tsc --noEmit`
Expected: No type errors

**Step 3: Commit**

```bash
cd ~/workspace/muxterm && git add web/ && git commit -m "feat(web): <mux-resize-handle> drag-to-resize component"
```

---

### Task 10: `<mux-app>` Root Component

The root component that wires everything together: creates the `MuxSocket`, subscribes to the `MuxStore`, routes pane output to `<mux-pane>` elements, translates user actions to WebSocket messages.

**Files:**
- Create: `web/src/app.ts`

**Step 1: Implement `<mux-app>`**

Create `web/src/app.ts`:

```typescript
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { MuxStore, store } from './state.js';
import { MuxSocket, buildWsUrl } from './ws.js';
import type { TmuxState, Window } from './types.js';

// Import all components (registers custom elements)
import './components/tab-bar.js';
import './components/layout.js';
import './components/status-bar.js';
import './components/pane.js';
import './components/resize-handle.js';
import type { MuxLayout } from './components/layout.js';

/**
 * <mux-app> — root component. Owns state + WebSocket, composes all children.
 */
@customElement('mux-app')
export class MuxApp extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100vw;
      height: 100vh;
      background: #1a1b26;
      color: #a9b1d6;
    }

    .overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(26, 27, 38, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      color: #e0af68;
      font-size: 16px;
    }

    .overlay.hidden {
      display: none;
    }
  `;

  @state()
  private _tmuxState: TmuxState = store.state;

  @state()
  private _connectionStatus: 'connected' | 'disconnected' | 'reconnecting' = 'disconnected';

  private _socket: MuxSocket | null = null;
  private _unsubscribe: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();

    // Subscribe to state changes
    this._unsubscribe = store.subscribe(() => {
      this._tmuxState = { ...store.state };
    });

    // Set up WebSocket connection
    this._socket = new MuxSocket(store, buildWsUrl('/ws'));

    // Route binary pane output to the correct <mux-pane> element
    this._socket.onPaneOutput((paneId: number, data: Uint8Array) => {
      this._routePaneOutput(paneId, data);
    });

    this._socket.connect();
    this._connectionStatus = 'reconnecting';

    // Track connection status (check periodically)
    this._pollConnectionStatus();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._socket?.disconnect();
  }

  render() {
    const activeSession = this._tmuxState.sessions.find(
      s => s.name === this._tmuxState.activeSession,
    );
    const windows = activeSession?.windows ?? [];
    const activeWindow = windows.find(w => w.id === this._tmuxState.activeWindow);
    const activePaneId = this._tmuxState.activePane
      ? parseInt(this._tmuxState.activePane.replace('%', ''), 10)
      : -1;

    return html`
      <mux-tab-bar
        .windows=${windows}
        active-window-id=${this._tmuxState.activeWindow}
        @tab-select=${this._onTabSelect}
        @tab-new=${this._onTabNew}
        @tab-close=${this._onTabClose}
      ></mux-tab-bar>

      <mux-layout
        layout-string=${activeWindow?.layout ?? ''}
        active-pane-id=${activePaneId}
        @pane-input=${this._onPaneInput}
        @pane-resize=${this._onPaneResize}
        @pane-focus=${this._onPaneSelect}
      ></mux-layout>

      <mux-status-bar
        sessionName=${this._tmuxState.activeSession}
        .windowCount=${windows.length}
        .paneCount=${activeWindow?.panes?.length ?? 0}
        activeWindowName=${activeWindow?.name ?? ''}
        connectionStatus=${this._connectionStatus}
      ></mux-status-bar>

      <div class="overlay ${this._connectionStatus === 'disconnected' ? '' : 'hidden'}">
        Connecting to muxterm...
      </div>
    `;
  }

  // --- Event handlers ---

  private _onTabSelect(e: CustomEvent<{ windowId: string }>): void {
    this._socket?.sendControl({ type: 'select-window', data: e.detail.windowId });
  }

  private _onTabNew(): void {
    this._socket?.sendControl({ type: 'new-window' });
  }

  private _onTabClose(e: CustomEvent<{ windowId: string }>): void {
    // Close all panes in the window (which closes the window)
    this._socket?.sendControl({ type: 'close-pane', data: e.detail.windowId });
  }

  private _onPaneInput(e: CustomEvent<{ paneId: number; data: Uint8Array }>): void {
    this._socket?.sendPaneInput(e.detail.paneId, e.detail.data);
  }

  private _onPaneResize(e: CustomEvent<{ paneId: number; cols: number; rows: number }>): void {
    this._socket?.sendControl({
      type: 'resize-pane',
      data: { id: `%${e.detail.paneId}`, cols: e.detail.cols, rows: e.detail.rows },
    });
  }

  private _onPaneSelect(e: CustomEvent<{ paneId: number }>): void {
    this._socket?.sendControl({ type: 'select-pane', data: `%${e.detail.paneId}` });
  }

  // --- Pane output routing ---

  private _routePaneOutput(paneId: number, data: Uint8Array): void {
    const layout = this.shadowRoot?.querySelector('mux-layout') as MuxLayout | null;
    if (!layout) return;

    const paneEl = layout.getPaneElement(paneId);
    if (paneEl && 'writeData' in paneEl) {
      (paneEl as any).writeData(data);
    }
  }

  // --- Connection status polling ---

  private _pollConnectionStatus(): void {
    const check = () => {
      if (!this._socket) return;
      const was = this._connectionStatus;
      const now = this._socket.connected ? 'connected' : 'reconnecting';
      if (was !== now) {
        this._connectionStatus = now;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-app': MuxApp;
  }
}
```

**Step 2: Verify the file type-checks**

Run: `cd ~/workspace/muxterm/web && npx tsc --noEmit`
Expected: No type errors

**Step 3: Verify all tests still pass**

Run: `cd ~/workspace/muxterm/web && npx vitest run`
Expected: All tests pass (layout-parser, state, ws, tab-bar, layout-component)

**Step 4: Commit**

```bash
cd ~/workspace/muxterm && git add web/ && git commit -m "feat(web): <mux-app> root component — wires state, WebSocket, and all children"
```

---

### Task 11: Vite Build & Dev Verification

Verify the frontend builds to `web/dist/` and the dev server renders the app.

**Files:**
- Modify: `web/index.html` (if needed for final polish)

**Step 1: Run Vite build**

Run: `cd ~/workspace/muxterm/web && npx vite build`
Expected: Output in `web/dist/` with `index.html`, JS bundles, and assets. No build errors.

If the build fails due to ghostty-web WASM bundling, add this to `vite.config.ts`:

```typescript
optimizeDeps: {
  exclude: ['ghostty-web'],
},
```

**Step 2: Check the dist output**

Run: `ls -la ~/workspace/muxterm/web/dist/ && du -sh ~/workspace/muxterm/web/dist/`
Expected: `index.html` + `assets/` directory with JS/CSS bundles

**Step 3: Run all tests one final time**

Run: `cd ~/workspace/muxterm/web && npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
cd ~/workspace/muxterm && git add web/ && git commit -m "build(web): verify Vite production build"
```

---

### Task 12: Go Embed & Makefile Integration

Update the `Makefile` to build the frontend and configure Go's `embed.FS` to serve it from the binary. This connects Phase 3 (frontend) to the Go server from Phases 1-2.

**Files:**
- Create: `Makefile`
- Create: `web/embed.go` (Go embed directive for the frontend)

**Step 1: Create `web/embed.go`**

This file lives at the Go module root and embeds `web/dist/` into the binary.

Create `~/workspace/muxterm/web/embed.go`:

```go
package web

import "embed"

// Dist contains the built frontend files from web/dist/.
// The Go server serves these via http.FileServer.
//
//go:embed dist/*
var Dist embed.FS
```

Note: This file will only compile after `web/dist/` exists (i.e., after `npm run build` in `web/`). The Go server in `internal/server/server.go` should import this package and serve the embedded files.

**Step 2: Create `Makefile`**

Create `~/workspace/muxterm/Makefile`:

```makefile
.PHONY: all build build-web build-go clean dev test test-web test-go

# Default target
all: build

# Build everything: frontend first, then Go binary with embedded frontend
build: build-web build-go

# Build the frontend (Vite + Lit + ghostty-web)
build-web:
	cd web && npm ci && npm run build

# Build the Go binary (includes embedded frontend from web/dist/)
build-go:
	go build -o muxterm ./cmd/muxterm

# Clean all build artifacts
clean:
	rm -rf web/dist web/node_modules muxterm

# Run Vite dev server (frontend only, hot reload)
dev:
	cd web && npm run dev

# Run all tests
test: test-web test-go

# Frontend tests
test-web:
	cd web && npm test

# Go tests
test-go:
	go test ./...
```

**Step 3: Verify the Makefile works for the frontend**

Run: `cd ~/workspace/muxterm && make build-web`
Expected: `web/dist/` populated with built frontend

Run: `cd ~/workspace/muxterm && make test-web`
Expected: All Vitest tests pass

**Step 4: Commit**

```bash
cd ~/workspace/muxterm && git add Makefile web/embed.go && git commit -m "build: Makefile + Go embed.FS for frontend integration"
```

---

## Verification Checklist

After all tasks are complete, verify:

1. **Tests pass:** `cd ~/workspace/muxterm/web && npx vitest run` — all green
2. **Type-checks pass:** `cd ~/workspace/muxterm/web && npx tsc --noEmit` — no errors
3. **Build succeeds:** `cd ~/workspace/muxterm/web && npx vite build` — dist/ populated
4. **Dev server starts:** `cd ~/workspace/muxterm/web && npx vite --port 5173` — serves index.html with `<mux-app>`
5. **Makefile works:** `cd ~/workspace/muxterm && make build-web && make test-web` — both pass

## Key Integration Points for Phase 4

Phase 3 produces a complete frontend that Phase 4 will connect to the Go server:

- **`MuxSocket`** connects to `ws://host:port/ws` — the Go server must handle WebSocket upgrade at `/ws`
- **Binary frames** use 4-byte LE uint32 pane ID prefix — Go server must match this encoding
- **JSON control messages** use `{ type: "...", data: ... }` format — Go server must produce and consume this
- **`web/embed.go`** exports `web.Dist` (embed.FS) — Go server imports and serves it via `http.FileServer`
- **ghostty-web WASM** is bundled by Vite — no separate WASM hosting needed
