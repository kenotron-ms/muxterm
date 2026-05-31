#!/usr/bin/env node
/**
 * content-fidelity.mjs — E2E proof that capture-pane == snapshot for a real pane.
 *
 * Proves the CONTENT-fidelity invariant end-to-end: tmux capture-pane output
 * must match the xterm.js StructuredSnapshot row-by-row (right-trimmed).
 *
 * Usage:
 *   node web/e2e/content-fidelity.mjs [--pane N] [--url URL]
 *
 * Options:
 *   --pane N    tmux pane id to target (default: 1)
 *   --url URL   dev server base URL (default: http://localhost:8080)
 *
 * Exit codes:
 *   0 — CONTENT fidelity holds (invariant proven)
 *   1 — divergence found between capture-pane and snapshot (diffs printed)
 *   2 — setup error: server down, pane not visible, snapshot null, or JSON parse failure
 *
 * Note: Node >=22.6 supports .ts imports via --experimental-strip-types.
 * If runtime errors occur on older Node versions, run:
 *   node --experimental-strip-types web/e2e/content-fidelity.mjs --pane 1
 */

import { execFileSync } from 'node:child_process';
import { compareContent } from './helpers/fidelity.ts';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let paneArg = '1';
let urlArg = 'http://localhost:8080';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pane' && i + 1 < args.length) {
    paneArg = args[++i];
  } else if (args[i].startsWith('--pane=')) {
    paneArg = args[i].slice('--pane='.length);
  } else if (args[i] === '--url' && i + 1 < args.length) {
    urlArg = args[++i];
  } else if (args[i].startsWith('--url=')) {
    urlArg = args[i].slice('--url='.length);
  }
}

const paneId = Number(paneArg);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  // Step 1: Oracle — tmux capture-pane -p -t %N
  const oracle = execFileSync('tmux', ['capture-pane', '-p', '-t', `%${paneId}`], {
    encoding: 'utf8',
  });

  // Step 2: Browser snapshot — open browser at URL, then eval snapshot API
  // playwright-cli maintains a persistent session; open returns once page loads.
  execFileSync('playwright-cli', ['open', urlArg], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const evalOutput = execFileSync(
    'playwright-cli',
    ['eval', `JSON.stringify(window.__muxterm.snapshot(${paneId}))`],
    { encoding: 'utf8' },
  );

  // Step 3: Extract JSON from playwright-cli output.
  // playwright-cli may wrap the result in surrounding text (page status, generated
  // code, snapshot sections), so we find the first '{' and last '}'.
  // When the eval returns a string (from JSON.stringify), playwright-cli further
  // wraps it in outer "..." with backslash-escaped inner quotes, e.g.:
  //   ### Result
  //   "{\"rows\":36,...}"
  // We detect this case ('"' immediately before '{' and after '}') and
  // double-parse: first to extract the inner JSON string, then to get the object.
  const firstBrace = evalOutput.indexOf('{');
  const lastBrace = evalOutput.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1) {
    console.error('No JSON found in playwright-cli output');
    process.exit(2);
  }

  let snapshot;
  try {
    if (evalOutput[firstBrace - 1] === '"' && evalOutput[lastBrace + 1] === '"') {
      // Double-encoded: outer "..." wraps the JSON string with escaped inner quotes.
      // JSON.parse the outer string first to get the inner JSON, then parse that.
      const innerJsonStr = JSON.parse(evalOutput.slice(firstBrace - 1, lastBrace + 2));
      snapshot = JSON.parse(innerJsonStr);
    } else {
      // Direct JSON: playwright-cli output has raw {...} without outer quotes.
      snapshot = JSON.parse(evalOutput.slice(firstBrace, lastBrace + 1));
    }
  } catch {
    console.error('Failed to parse JSON from playwright-cli output');
    process.exit(2);
  }

  // Exit 2 if the snapshot does not contain rowText (pane not ensured/visible).
  if (!Array.isArray(snapshot.rowText)) {
    console.error(`snapshot.rowText is not an array — pane %${paneId} not ensured/visible`);
    process.exit(2);
  }

  // Step 4: Compare oracle text against snapshot
  const result = compareContent(oracle, snapshot);

  if (result.ok) {
    console.log(`✓ CONTENT fidelity holds for pane %${paneId} (${snapshot.rowText.length} rows)`);
    process.exit(0);
  } else {
    for (const diff of result.diffs) {
      console.log(
        `row ${diff.row} [${diff.reason}]: expected=${diff.expected} actual=${diff.actual}`,
      );
    }
    process.exit(1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
