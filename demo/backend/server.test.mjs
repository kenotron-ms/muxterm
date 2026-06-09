/**
 * Integration tests for demo/backend/server.mjs
 *
 * Uses a dynamically-allocated free port (via net.createServer on port 0) to
 * avoid EADDRINUSE when port 9002 is already occupied by a running demo server.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));

/** Return an OS-assigned free port. */
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let serverProcess;
let serverOutput = '';
let PORT;
let BASE_URL;

describe('demo backend server', () => {
  before(async () => {
    PORT = await getFreePort();
    BASE_URL = `http://localhost:${PORT}`;

    serverProcess = spawn('node', ['server.mjs'], {
      cwd: DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT) },
    });

    serverProcess.stdout.on('data', (d) => { serverOutput += d.toString(); });
    serverProcess.stderr.on('data', (d) => { serverOutput += d.toString(); });

    // Wait up to 5 s for the ready message
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (serverOutput.includes(`listening on http://localhost:${PORT}`)) break;
      await sleep(100);
    }

    if (!serverOutput.includes(`listening on http://localhost:${PORT}`)) {
      throw new Error(`Server did not start within 5 s.\nOutput: ${serverOutput}`);
    }
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await sleep(200);
    }
  });

  test('server prints correct startup message', () => {
    assert.ok(
      serverOutput.includes(`[demo backend] listening on http://localhost:${PORT}`),
      `Expected startup message not found.\nGot: ${serverOutput}`,
    );
  });

  test('GET /api/health returns {ok:true}', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  });

  test('GET /api/items returns JSON array with CORS header', async () => {
    const res = await fetch(`${BASE_URL}/api/items`);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      '*',
      'Expected CORS header Access-Control-Allow-Origin: *',
    );
    const body = await res.json();
    assert.ok(Array.isArray(body), 'Expected JSON array');
    assert.ok(body.length >= 3, `Expected at least 3 items, got ${body.length}`);
  });

  test('GET /api/items returns items with correct initial structure including ts', async () => {
    const res = await fetch(`${BASE_URL}/api/items`);
    const items = await res.json();

    // First item: id=1, status=ok, label=Database
    assert.equal(items[0].id, 1);
    assert.equal(items[0].status, 'ok');
    assert.equal(items[0].label, 'Database');
    assert.ok(items[0].ts, 'Expected ts field on first item');
    assert.doesNotThrow(
      () => new Date(items[0].ts).toISOString(),
      'Expected ts to be a valid ISO 8601 date string',
    );

    // Third item: id=3, status=warn, label=Queue
    assert.equal(items[2].id, 3);
    assert.equal(items[2].status, 'warn');
    assert.equal(items[2].label, 'Queue');
  });

  test('GET /api/items response body starts with [{ (acceptance criteria)', async () => {
    const res = await fetch(`${BASE_URL}/api/items`);
    const text = await res.text();
    assert.ok(
      text.trimStart().startsWith('[{'),
      `Expected response to start with '[{', got: ${text.slice(0, 20)}`,
    );
  });
});
