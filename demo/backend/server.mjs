/**
 * demo/backend/server.mjs — Demo Express + WebSocket backend for muxterm browser pane.
 *
 * Listens on port 9002.
 * Routes:
 *   GET  /api/items     → JSON array of sample items
 *   GET  /api/health    → { status: "ok" }
 *   WS   /ws            → echo WebSocket endpoint
 *
 * Usage:  node server.mjs
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = 9002;

// Minimal CORS + JSON response helper
function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const ITEMS = [
  { id: 1, name: 'Alpha', status: 'active' },
  { id: 2, name: 'Beta', status: 'active' },
  { id: 3, name: 'Gamma', status: 'idle' },
  { id: 4, name: 'Delta', status: 'active' },
  { id: 5, name: 'Epsilon', status: 'idle' },
];

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  if (url.pathname === '/api/items' && req.method === 'GET') {
    json(res, ITEMS);
    return;
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    json(res, { status: 'ok', port: PORT });
    return;
  }

  json(res, { error: 'not found' }, 404);
});

// WebSocket echo server on /ws
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected', message: 'muxterm demo backend ready' }));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      ws.send(JSON.stringify({ type: 'echo', payload: msg }));
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`muxterm demo backend listening on http://localhost:${PORT}`);
  console.log(`  GET  /api/items  → JSON array`);
  console.log(`  GET  /api/health → health check`);
  console.log(`  WS   /ws         → echo WebSocket`);
});
