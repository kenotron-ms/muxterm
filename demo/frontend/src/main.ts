/**
 * demo/frontend/src/main.ts
 *
 * Vite + TypeScript frontend for the muxterm demo.
 * Uses absolute localhost:9002 URLs so it works when proxied through
 * muxterm's /p/5173/ browser-pane proxy (the proxy rewrites the host).
 */

const API_BASE = 'http://localhost:9002';
const WS_URL = 'ws://localhost:9002/ws';

interface Item {
  id: number;
  name: string;
  status: 'active' | 'idle';
}

interface WsMessage {
  type: string;
  message?: string;
  payload?: unknown;
}

async function loadItems(): Promise<void> {
  const statusEl = document.getElementById('status')!;
  const listEl = document.getElementById('items')!;

  try {
    const resp = await fetch(`${API_BASE}/api/items`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const items: Item[] = await resp.json() as Item[];

    statusEl.textContent = `Loaded ${items.length} items from ${API_BASE}`;
    listEl.innerHTML = items
      .map(
        (item) =>
          `<li><span class="${item.status}">[${item.status}]</span> #${item.id} — ${item.name}</li>`,
      )
      .join('');
  } catch (err) {
    statusEl.textContent = `Error: ${String(err)} — is the backend running on port 9002?`;
  }
}

function connectWebSocket(): void {
  const wsEl = document.getElementById('ws-status')!;
  try {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      wsEl.textContent = `WebSocket connected to ${WS_URL}`;
      ws.send(JSON.stringify({ hello: 'muxterm demo' }));
    };
    ws.onmessage = (ev: MessageEvent<string>) => {
      const msg = JSON.parse(ev.data) as WsMessage;
      wsEl.textContent = `WS message: ${msg.type} — ${JSON.stringify(msg.payload ?? msg.message)}`;
    };
    ws.onerror = () => {
      wsEl.textContent = `WebSocket error — is the backend running on port 9002?`;
    };
  } catch {
    wsEl.textContent = `WebSocket not available`;
  }
}

loadItems();
connectWebSocket();
