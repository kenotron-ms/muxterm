import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

const PORT = process.env.PORT ?? 9002;

// In-memory items array with 3 seed items
const items = [
  { id: 1, status: 'ok',   label: 'Database',  ts: new Date().toISOString() },
  { id: 2, status: 'ok',   label: 'Cache',     ts: new Date().toISOString() },
  { id: 3, status: 'warn', label: 'Queue',     ts: new Date().toISOString() },
];

let nextId = 4;

const STATUSES = ['ok', 'ok', 'ok', 'warn', 'error'];
const LABELS   = ['Database', 'Cache', 'Queue', 'API', 'Worker', 'Scheduler', 'Proxy'];

function newItem() {
  const status = STATUSES[Math.floor(Math.random() * STATUSES.length)];
  const label  = LABELS[Math.floor(Math.random() * LABELS.length)];
  const item   = { id: nextId++, status, label, ts: new Date().toISOString() };
  items.push(item);
  if (items.length > 100) items.splice(0, items.length - 100);
  return item;
}

// Express app
const app = express();

// CORS middleware — allow the Vite dev server (port 5173) and the muxterm proxy
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/items',  (_req, res) => res.json(items));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// HTTP server (shared with WebSocket)
const server = createServer(app);

// WebSocket server on /ws
const clients = new Set();
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  // Send current snapshot to new client
  ws.send(JSON.stringify({ type: 'snapshot', items }));
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// Broadcast a new item every 3 seconds
setInterval(() => {
  const item = newItem();
  const msg  = JSON.stringify({ type: 'item', item });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}, 3000);

server.listen(PORT, () => {
  console.log(`[demo backend] listening on http://localhost:${PORT}`);
});
