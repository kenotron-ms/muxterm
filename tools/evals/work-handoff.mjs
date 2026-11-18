#!/usr/bin/env node
// Integration eval: a real browser creates isolated projects and Codex chats in
// a DTU; the chats use Muxterm's real MCP tools and Work dispatch machinery.
// Usage: MUXTERM_EVAL_URL=http://127.0.0.1:18413 node tools/evals/work-handoff.mjs
// Evidence is written outside the repository, under MUXTERM_EVAL_OUTPUT.
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from '../../web/node_modules/playwright/index.mjs';

const base = new URL(process.env.MUXTERM_EVAL_URL || 'http://127.0.0.1:18413');
if (!['127.0.0.1', 'localhost'].includes(base.hostname) || ['8311', '9090'].includes(base.port)) {
  throw new Error('Eval URL must be a local DTU proxy, never production');
}
const output = process.env.MUXTERM_EVAL_OUTPUT || '/home/ken/artifacts/work-handoff-eval-20261118/runs';
const container = process.env.MUXTERM_EVAL_CONTAINER || '';
if (!/^muxterm-work-handoff-eval-[a-z0-9-]+$/.test(container)) throw new Error('Set MUXTERM_EVAL_CONTAINER to the isolated evaluation DTU');
const proxyListen = execFileSync('incus', ['config', 'device', 'get', container, 'web', 'listen'], { encoding: 'utf8' }).trim();
if (base.protocol !== 'http:' || proxyListen !== `tcp:${base.hostname}:${base.port}`) throw new Error('Eval URL does not match the selected DTU proxy');
const runID = randomUUID().slice(0, 8);
const selected = new Set((process.argv.slice(2).length ? process.argv.slice(2) : ['baseline', 'explicit-a', 'explicit-b', 'ambiguous', 'policy', 'policy-minimal', 'self-claim']).map(String));
const cases = [
  {
    id: 'baseline',
    task: 'Add a short GLOSSARY.md explaining the terms Work item and owner.',
    prompt: task => `Create a Work item to ${task} Start it and let Muxterm choose or create a chat to do the work.`,
  },
  {
    id: 'explicit-a',
    task: 'Add a short GLOSSARY.md explaining the terms Work item and owner.',
    prompt: task => `Act only as coordinator for this request: ${task} Create an unassigned Work item tied to this project, with a concrete next action and acceptance criteria. Do not edit files or claim the item in this chat. Call start_work_item for the new item. Read the returned dispatch and the Work record until a different chat claims ownership; report that chat and the Work ID. If kickoff or claim fails, report the failure instead of doing the task yourself.`,
  },
  {
    id: 'explicit-b',
    task: 'Add a short DESIGN.md describing a one-line status badge feature.',
    prompt: task => `Please coordinate this feature: ${task} First create a Work item in this project without an owner. Give it an observable completion condition and a next action. Then invoke start_work_item so Muxterm sends it to a worker chat. Stay in the coordinator role: do not make the file or assign yourself. Confirm from get_work_item that the dispatch chat, not this chat, claimed the item. Report the Work ID and worker chat ID.`,
  },
  {
    id: 'ambiguous',
    expectedHandoff: false,
    task: 'The project needs a glossary. Please start work on that.',
    prompt: task => task,
  },
  {
    id: 'policy',
    task: 'The project needs a glossary. Please start work on that.',
    prompt: task => task,
    policy: 'full',
  },
  {
    id: 'policy-minimal',
    task: 'The project needs a glossary. Please start work on that.',
    prompt: task => task,
    policy: 'minimal',
  },
  {
    id: 'self-claim',
    expectedHandoff: false,
    task: 'Add a short GLOSSARY.md explaining the terms Work item and owner.',
    prompt: task => `Create a Work item to ${task} You may implement it yourself in this chat.`,
  },
].filter(testCase => selected.has(testCase.id));
if (!cases.length) throw new Error(`No selected scenarios: ${[...selected].join(', ')}`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(base.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
async function api(method, path, body) {
  const result = await page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data };
  }, { method, path, body });
  if (result.status >= 400) throw new Error(`${method} ${path}: ${result.status} ${typeof result.data === 'string' ? result.data : JSON.stringify(result.data)}`);
  return result.data;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle(chatID, timeoutMs = 240000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await api('GET', `/api/sdk-chats/${chatID}`);
    if (['ready', 'error', 'failed'].includes(last.state)) return last;
    await pause(2000);
  }
  return last;
}
async function history(chatID) {
  return await api('GET', `/api/sdk-chats/${chatID}/history`);
}
async function workFor(projectID) {
  return (await api('GET', `/api/sdk-work?project_id=${encodeURIComponent(projectID)}`)).work || [];
}
function readableHistory(history) {
  const lines = [];
  let current = { type: '', itemID: '', text: '' };
  const flush = () => {
    if (current.text.trim()) lines.push(`**${current.type === 'commentary.delta' ? 'Progress' : 'Assistant'}:** ${current.text.trim()}`);
    current = { type: '', itemID: '', text: '' };
  };
  for (const event of history?.events || []) {
    if (event.type === 'assistant.delta' || event.type === 'commentary.delta') {
      if (current.type !== event.type || current.itemID !== event.itemId) flush();
      current.type = event.type;
      current.itemID = event.itemId;
      current.text += event.text || '';
    } else if (event.type === 'tool.started') {
      flush();
      lines.push(`**Tool:** ${event.name || 'unknown'}`);
    } else if (event.type === 'work.updated') {
      flush();
      lines.push(`**Work update:** ${event.text || event.workId || ''}`);
    }
  }
  flush();
  return lines.join('\n\n');
}

await mkdir(output, { recursive: true });
const report = { runID, base: base.href, startedAt: new Date().toISOString(), scenarios: [] };
try {
  for (const testCase of cases) {
    const started = Date.now();
    const result = { scenario: testCase.id, prompt: testCase.prompt(testCase.task) };
    report.scenarios.push(result);
    try {
      const project = await api('POST', '/api/sdk-projects', { Name: `Handoff eval ${testCase.id} ${runID}`, ManagedFolder: true });
      result.projectID = project.id;
      const fixtureFile = `${output}/${runID}-${testCase.id}.README.md`;
      await writeFile(fixtureFile, '# Example project\n\nThis is a small documentation project for the handoff evaluation. A Work item is a durable task record. Its owner is the chat responsible for carrying out the task. Work statuses are open, active, blocked, review, done, and cancelled. A status badge is a one-line label that shows the current Work status. Keep new documentation short and grounded in these facts.\n');
      execFileSync('incus', ['file', 'push', fixtureFile, `${container}${project.path}/README.md`, '--mode', '644', '--quiet']);
      if (testCase.policy) {
        const policy = testCase.policy === 'minimal'
          ? `# Work handoff\n\nWhen a user asks to start work, create an unassigned Work item for this project (${project.id}) with a next action and acceptance criteria. Call start_work_item. Do not claim or implement in this chat. Confirm another chat claimed the item; otherwise report the blocker.\n`
          : `# Work handoff in this project\n\nWhen a person says to start work, act as a coordinator in the requesting chat. Create one unassigned Work item for the outcome, tied to project ${project.id}, with a concrete next action and observable acceptance criteria. Call start_work_item with a stable client_ref. Do not claim the item or implement it in the requesting chat. Read the Work record until a different chat claims it, then report that chat and Work ID. If kickoff or claim fails, report the blocker; do not silently take over the task. The dispatched worker may perform the implementation.\n`;
        const policyFile = `${output}/${runID}-${testCase.id}.AGENTS.md`;
        await writeFile(policyFile, policy);
        execFileSync('incus', ['file', 'push', policyFile, `${container}${project.path}/AGENTS.md`, '--mode', '644', '--quiet']);
      }
      const chat = await api('POST', '/api/sdk-chats', { WorkspaceID: project.id, Harness: 'codex', WorkMode: 'local', Prompt: result.prompt });
      result.coordinatorID = chat.id;
      result.coordinator = await settle(chat.id);
      const items = await workFor(project.id);
      result.workIDs = items.map(item => item.id);
      if (items.length === 1) {
        let item = await api('GET', `/api/sdk-work/${items[0].id}`);
        const until = Date.now() + 180000;
        while (item.dispatch && item.dispatch.state !== 'claimed' && Date.now() < until) {
          await pause(2000);
          item = await api('GET', `/api/sdk-work/${item.id}`);
          if (['failed', 'uncertain'].includes(item.dispatch?.state)) break;
        }
        result.work = item;
        if (item.dispatch?.sessionId && item.dispatch.sessionId !== chat.id) {
          result.worker = await settle(item.dispatch.sessionId, 120000);
          result.workerHistory = await history(item.dispatch.sessionId);
          result.work = await api('GET', `/api/sdk-work/${item.id}`);
        }
      }
      result.coordinatorHistory = await history(chat.id);
      result.pass = items.length === 1 && !!result.work?.dispatch && result.work.dispatch.state === 'claimed' && result.work.ownerSessionId === result.work.dispatch.sessionId && result.work.ownerSessionId !== chat.id;
      result.workerCompleted = result.work?.status === 'done';
    } catch (error) {
      result.error = String(error);
      result.pass = false;
    }
    result.elapsedMs = Date.now() - started;
    result.expectedHandoff = testCase.expectedHandoff ?? true;
    result.matchesExpectation = !result.error && !['error', 'failed'].includes(result.coordinator?.state) && result.pass === result.expectedHandoff && (!result.expectedHandoff || result.workerCompleted);
    console.log(`${testCase.id}: ${result.pass ? 'PASS' : 'FAIL'} coordinator=${result.coordinatorID || '-'} owner=${result.work?.ownerSessionId || '-'} dispatch=${result.work?.dispatch?.state || '-'} status=${result.work?.status || '-'} ${result.error || ''}`);
    const transcript = [`# ${testCase.id}`, `**User:** ${result.prompt}`, `## Coordinator ${result.coordinatorID || 'unavailable'}`, readableHistory(result.coordinatorHistory), `## Worker ${result.work?.dispatch?.sessionId || 'none'}`, readableHistory(result.workerHistory)].join('\n\n');
    await writeFile(`${output}/${runID}-${testCase.id}-transcript.md`, transcript);
    await writeFile(`${output}/${runID}.json`, JSON.stringify(report, null, 2));
  }
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(`${output}/${runID}.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
if (report.scenarios.some(scenario => !scenario.matchesExpectation)) process.exitCode = 1;
