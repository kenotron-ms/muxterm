export interface Pane {
  id: number;
  width: number;
  height: number;
  active: boolean;
}

export interface Window {
  id: number;
  name: string;
  panes: Pane[];
  layout: string;
}

export interface Session {
  name: string;
  windows: Window[];
}

export interface TmuxState {
  sessions: Session[];
  activeSession: string;
  activeWindow: number;
  activePane: number;
}

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

export type ServerMessage =
  | { type: 'full-sync'; data: TmuxState }   // on-connect: full replace + terminal reset
  | { type: 'state'; data: TmuxState }        // periodic: structural reconciliation only
  | { type: 'window-add'; data: Window }
  | { type: 'window-renamed'; data: { id: number; name: string } }
  | { type: 'window-close'; data: { id: number } }
  | { type: 'layout-change'; data: { windowId: number; layout: string } }
  | { type: 'session-changed'; data: { name: string } }
  | { type: 'session-window-changed'; data: { windowId: number } }
  | { type: 'pane-mode'; data: { paneId: number; mode: string } }
  | { type: 'detached'; data: { reason: string } }
  | { type: 'error'; data: { message: string } };

export type ClientMessage =
  | { type: 'select-window'; windowId: number }
  | { type: 'select-pane'; paneId: number }
  | { type: 'split'; direction: SplitDirection; paneId: number }
  | { type: 'resize-pane'; paneId: number; cols: number; rows: number }
  | { type: 'new-window' }
  | { type: 'close-pane'; paneId: number }
  | { type: 'close-window'; windowId: number }
  | { type: 'rename-window'; windowId: number; name: string }
  | { type: 'create-session'; name: string }
  | { type: 'pane-scroll'; paneId: number; up: boolean; lines: number }
  | { type: 'request-sync' };

export interface MuxStoreEvents {
  change: TmuxState;
  'pane-output': { paneId: number; data: Uint8Array };
  disconnected: { reason: string };
  reconnecting: { attempt: number };
  connected: void;
}