const BACKEND_HTTP = 'http://localhost:9002';
const BACKEND_WS = 'ws://localhost:9002';

interface StatusItem {
  id: number;
  status: 'ok' | 'warn' | 'error';
  label: string;
  ts: string;
}

type WsMessage =
  | { type: 'snapshot'; items: StatusItem[] }
  | { type: 'item'; item: StatusItem };

function renderItem(item: StatusItem, prepend: boolean): void {
  const itemsDiv = document.getElementById('items');
  if (!itemsDiv) return;

  const div = document.createElement('div');
  div.className = `item ${item.status}`;
  div.dataset['id'] = String(item.id);

  const labelSpan = document.createElement('span');
  labelSpan.className = 'label';
  labelSpan.textContent = item.label;

  const statusSpan = document.createElement('span');
  statusSpan.className = 'status';
  statusSpan.textContent = item.status;

  const tsSpan = document.createElement('span');
  tsSpan.className = 'ts';
  tsSpan.textContent = item.ts ? new Date(item.ts).toLocaleTimeString() : '';

  div.appendChild(labelSpan);
  div.appendChild(statusSpan);
  div.appendChild(tsSpan);

  if (prepend) {
    itemsDiv.prepend(div);
    // Trim to 50 visible items
    while (itemsDiv.children.length > 50) {
      const last = itemsDiv.lastElementChild;
      if (last) {
        itemsDiv.removeChild(last);
      } else {
        break;
      }
    }
  } else {
    itemsDiv.appendChild(div);
  }
}

async function loadInitial(): Promise<void> {
  try {
    const response = await fetch(`${BACKEND_HTTP}/api/items`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const items = (await response.json()) as StatusItem[];

    const statusLine = document.getElementById('status-line');
    if (statusLine) {
      statusLine.textContent = `Loaded ${items.length} items`;
    }
  } catch (err) {
    const statusLine = document.getElementById('status-line');
    if (statusLine) statusLine.textContent = `Failed to load items: ${err}`;
    throw err;
  }
}

function connectWebSocket(): void {
  const ws = new WebSocket(`${BACKEND_WS}/ws`);

  ws.addEventListener('message', (event: MessageEvent) => {
    const data = JSON.parse(event.data as string) as WsMessage;

    if (data.type === 'snapshot') {
      const itemsDiv = document.getElementById('items');
      if (itemsDiv) {
        itemsDiv.innerHTML = '';
      }
      data.items.forEach((item) => {
        renderItem(item, false);
      });
      const statusLine = document.getElementById('status-line');
      if (statusLine) statusLine.textContent = `${data.items.length} items — live`;
    } else if (data.type === 'item') {
      renderItem(data.item, true);
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(connectWebSocket, 3000);
  });
}

loadInitial()
  .then(connectWebSocket)
  .catch((err: unknown) => {
    console.error('Startup failed:', err);
  });
