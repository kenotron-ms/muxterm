#!/usr/bin/env node
/**
 * Strict acceptance driver for the crash-recovery DTU profile.
 *
 * The only live scenario is preflight. The other scenarios intentionally
 * report their current blockers without probing a server or a future API.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const DRIVER_SCHEMA = 'muxterm-crash-recovery-driver/v1';
const READINESS_SCHEMA = 'muxterm-crash-recovery-dtu/v1';
const REQUIRED_CAPABILITY = 'shell-safe-non-disk-dtu-api-proxy';
const PINNED_GO_VERSION = 'go1.24.4';
const PINNED_NODE_VERSION = 'v22.18.0';
const PINNED_UV_VERSION = '0.12.5';
const PINNED_PLAYWRIGHT_CLI_VERSION = '0.1.18';
const FETCH_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;

const SCENARIOS = new Set([
  'preflight',
  'structural',
  'amplifier',
  'claude',
  'opencode',
  'codex',
  'all',
]);

const TOOL_SCENARIOS = new Set(['amplifier', 'claude', 'opencode', 'codex']);

const REQUIRED_READINESS_CHECKS = [
  'exact_muxterm_ref',
  'muxterm_binary',
  'strategy_binaries',
  'strategy_versions',
  'owner_only_directories',
  'real_pty',
  'chromium_binary',
  'muxterm_http',
];

const EXPECTED_STRATEGY_VERSIONS = {
  amplifier: '0.1.1',
  claude: '2.1.236',
  opencode: '1.18.21',
  codex: '0.149.0',
  playwright_cli: '0.1.18',
};

const BROWSER_HEALTH_EVALUATION = `(async () => {
  const response = await fetch('/api/health');
  const reader = response.body && response.body.getReader();
  if (!reader) {
    return JSON.stringify({ http_ok: response.ok, json: false, health: false });
  }

  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > ${MAX_RESPONSE_BYTES}) {
      await reader.cancel();
      return JSON.stringify({ http_ok: response.ok, json: false, health: false });
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return JSON.stringify({ http_ok: response.ok, json: false, health: false });
  }

  const health = body !== null
    && typeof body === 'object'
    && !Array.isArray(body)
    && Object.keys(body).length === 1
    && body.status === 'ok';
  return JSON.stringify({ http_ok: response.ok, json: true, health });
})()`;

class SetupError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactObject(value, expected) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (keys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key, index) => keys[index] === key && value[key] === expected[key]);
}

function exactVersionMap(value) {
  return exactObject(value, EXPECTED_STRATEGY_VERSIONS);
}

function canonicalVersionOutputMap(value) {
  if (!isRecord(value)) return undefined;

  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(EXPECTED_STRATEGY_VERSIONS).sort();
  if (keys.length !== expectedKeys.length
    || !expectedKeys.every((key, index) => keys[index] === key)) {
    return undefined;
  }

  const canonical = {};
  for (const key of expectedKeys) {
    const version = stableVersionFromOutput(value[key]);
    if (version === undefined) return undefined;
    canonical[key] = version;
  }
  return canonical;
}

function semanticHealth(value) {
  return isRecord(value) && value.status === 'ok';
}

function expectedUnavailable(value) {
  return isRecord(value)
    && value.available === false
    && value.code === 'credentials-unavailable'
    && value.required_capability === REQUIRED_CAPABILITY;
}

function pinnedGoVersion(value) {
  if (!isNonEmptyString(value)) return false;
  const fields = value.split(/\s+/);
  return fields[0] === 'go' && fields[1] === 'version' && fields[2] === PINNED_GO_VERSION;
}

function pinnedUvVersion(value) {
  if (!isNonEmptyString(value)) return false;
  const fields = value.split(/\s+/);
  return fields[0] === 'uv' && fields[1] === PINNED_UV_VERSION;
}

function createDocument({ scenario, url, ok, code, checks, details }) {
  const document = {
    schema: DRIVER_SCHEMA,
  };
  if (scenario !== undefined) document.scenario = scenario;
  if (url !== undefined) document.url = url;
  document.ok = ok;
  document.code = code;
  document.checks = checks;
  if (details !== undefined && Object.keys(details).length > 0) {
    document.details = details;
  }
  return document;
}

function addArgumentError(errors, code) {
  errors.add(code);
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    return { valid: false, error: 'invalid-url' };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { valid: false, error: 'invalid-url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'invalid-url-scheme' };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { valid: false, error: 'url-credentials-not-allowed' };
  }

  return { valid: true, url: parsed.toString() };
}

function parseArguments(argv) {
  const values = {
    url: [],
    scenario: [],
  };
  const errors = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const inline = argument.match(/^(--url|--scenario)=(.*)$/);

    if (inline) {
      values[inline[1].slice(2)].push(inline[2]);
      continue;
    }

    if (argument === '--url' || argument === '--scenario') {
      const field = argument.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        values[field].push(undefined);
        addArgumentError(errors, `missing-${field}`);
      } else {
        values[field].push(next);
        index += 1;
      }
      continue;
    }

    if (argument.startsWith('-')) {
      addArgumentError(errors, 'unknown-flag');
    } else {
      addArgumentError(errors, 'positional-argument');
    }
  }

  for (const field of ['url', 'scenario']) {
    if (values[field].length === 0) {
      addArgumentError(errors, `missing-${field}`);
    } else if (values[field].length > 1) {
      addArgumentError(errors, `duplicate-${field}`);
    } else if (typeof values[field][0] !== 'string' || values[field][0].trim().length === 0) {
      addArgumentError(errors, `empty-${field}`);
    }
  }

  let url;
  if (values.url.length === 1 && typeof values.url[0] === 'string' && values.url[0].trim().length > 0) {
    const normalized = normalizeBaseUrl(values.url[0]);
    if (normalized.valid) {
      url = normalized.url;
    } else {
      addArgumentError(errors, normalized.error);
    }
  }

  let scenario;
  if (values.scenario.length === 1 && typeof values.scenario[0] === 'string' && values.scenario[0].trim().length > 0) {
    if (SCENARIOS.has(values.scenario[0])) {
      scenario = values.scenario[0];
    } else {
      addArgumentError(errors, 'invalid-scenario');
    }
  }

  return {
    ok: errors.size === 0,
    errors: [...errors].sort(),
    scenario,
    url,
  };
}

function invalidArgumentsOutcome(parsed) {
  return {
    exitCode: 2,
    document: createDocument({
      scenario: parsed.scenario,
      url: parsed.url,
      ok: false,
      code: 'invalid-arguments',
      checks: {
        arguments: false,
      },
      details: {
        errors: parsed.errors,
      },
    }),
  };
}

function blockedScenarioOutcome(scenario, url) {
  const checks = {
    arguments: true,
    live_preflight_not_run: true,
  };

  if (scenario === 'structural') {
    checks.structural_runtime_capability = false;
    return {
      exitCode: 1,
      document: createDocument({
        scenario,
        url,
        ok: false,
        code: 'runtime-capability-missing',
        checks,
        details: {
          blockers: ['runtime-capability-missing'],
        },
      }),
    };
  }

  if (TOOL_SCENARIOS.has(scenario)) {
    checks.safe_credential_delivery = false;
    return {
      exitCode: 1,
      document: createDocument({
        scenario,
        url,
        ok: false,
        code: 'credentials-unavailable',
        checks,
        details: {
          blockers: ['credentials-unavailable'],
          required_capability: REQUIRED_CAPABILITY,
        },
      }),
    };
  }

  checks.structural_runtime_capability = false;
  checks.safe_credential_delivery = false;
  return {
    exitCode: 1,
    document: createDocument({
      scenario,
      url,
      ok: false,
      code: 'runtime-capability-missing',
      checks,
      details: {
        blockers: ['runtime-capability-missing', 'credentials-unavailable'],
        required_capability: REQUIRED_CAPABILITY,
      },
    }),
  };
}

function addAssertion(checks, failures, name, condition) {
  checks[name] = condition === true;
  if (!checks[name]) failures.push(name);
}

function validateReadiness(evidence) {
  const checks = {};
  const failures = [];
  const root = isRecord(evidence);
  const readinessChecks = root && isRecord(evidence.checks) ? evidence.checks : undefined;
  const muxterm = root && isRecord(evidence.muxterm) ? evidence.muxterm : undefined;
  const os = root && isRecord(evidence.os) ? evidence.os : undefined;
  const toolchain = root && isRecord(evidence.toolchain) ? evidence.toolchain : undefined;
  const playwright = root && isRecord(evidence.playwright) ? evidence.playwright : undefined;
  const capabilities = root && isRecord(evidence.capabilities) ? evidence.capabilities : undefined;

  addAssertion(checks, failures, 'readiness_document', root);
  addAssertion(checks, failures, 'readiness_schema', root && evidence.schema === READINESS_SCHEMA);
  addAssertion(checks, failures, 'readiness_operational_ready', root && evidence.operational_ready === true);
  addAssertion(checks, failures, 'readiness_ready', root && evidence.ready === true);
  addAssertion(checks, failures, 'os_ubuntu_2404',
    isRecord(os) && os.id === 'ubuntu' && os.version === '24.04');

  const requiredChecksPass = REQUIRED_READINESS_CHECKS.every((name) => readinessChecks?.[name] === true);
  addAssertion(checks, failures, 'readiness_required_checks', requiredChecksPass);
  for (const name of REQUIRED_READINESS_CHECKS) {
    addAssertion(checks, failures, `readiness_${name}`, readinessChecks?.[name] === true);
  }

  addAssertion(checks, failures, 'muxterm_ref',
    isRecord(muxterm) && /^[0-9a-f]{40}$/.test(muxterm.ref));
  addAssertion(checks, failures, 'muxterm_sha256',
    isRecord(muxterm) && /^[0-9a-f]{64}$/.test(muxterm.sha256));
  addAssertion(checks, failures, 'muxterm_version_output',
    isRecord(muxterm) && isNonEmptyString(muxterm.version_output));
  addAssertion(checks, failures, 'muxterm_http_health',
    isRecord(muxterm) && semanticHealth(muxterm.http_health));

  addAssertion(checks, failures, 'strategy_cli_expected_versions',
    root && exactVersionMap(evidence.strategy_cli_expected_versions));
  addAssertion(checks, failures, 'strategy_cli_package_versions',
    root && exactVersionMap(evidence.strategy_cli_package_versions));
  addAssertion(checks, failures, 'strategy_cli_version_output',
    root && exactVersionMap(canonicalVersionOutputMap(evidence.strategy_cli_version_output)));

  addAssertion(checks, failures, 'toolchain_go',
    isRecord(toolchain) && pinnedGoVersion(toolchain.go));
  addAssertion(checks, failures, 'toolchain_node',
    isRecord(toolchain) && toolchain.node === PINNED_NODE_VERSION);
  addAssertion(checks, failures, 'toolchain_uv',
    isRecord(toolchain) && pinnedUvVersion(toolchain.uv));

  addAssertion(checks, failures, 'chromium_executable_evidence',
    isRecord(playwright) && isNonEmptyString(playwright.chromium_executable));
  addAssertion(checks, failures, 'chromium_version_evidence',
    isRecord(playwright) && isNonEmptyString(playwright.chromium_version));

  addAssertion(checks, failures, 'safe_credential_delivery_unavailable',
    isRecord(capabilities) && expectedUnavailable(capabilities.safe_credential_delivery));
  addAssertion(checks, failures, 'tool_scenarios_unavailable',
    isRecord(capabilities) && expectedUnavailable(capabilities.tool_scenarios));

  return { checks, failures };
}

function outputFromChild(result) {
  if (typeof result.stdout === 'string') return result.stdout;
  if (Buffer.isBuffer(result.stdout)) return result.stdout.toString('utf8');
  return '';
}

function runPlaywright(args, label) {
  let result;
  try {
    result = spawnSync('playwright-cli', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_CHILD_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch {
    throw new SetupError(`${label}-spawn-failed`);
  }

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new SetupError(`${label}-timeout`);
    }
    if (result.error.code === 'ENOBUFS') {
      throw new SetupError(`${label}-output-too-large`);
    }
    throw new SetupError(`${label}-unavailable`);
  }
  if (result.status !== 0) {
    throw new SetupError(`${label}-failed`);
  }

  const stdout = outputFromChild(result);
  if (Buffer.byteLength(stdout, 'utf8') > MAX_CHILD_OUTPUT_BYTES) {
    throw new SetupError(`${label}-output-too-large`);
  }
  return stdout;
}

async function readBoundedResponse(response, label) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new SetupError(`${label}-response-too-large`);
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The primary size failure remains authoritative.
        }
        throw new SetupError(`${label}-response-too-large`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SetupError(`${label}-malformed-json`);
  }
}

async function fetchJson(endpoint, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(endpoint, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof SetupError) throw error;
      if (error?.name === 'AbortError') throw new SetupError(`${label}-timeout`);
      throw new SetupError(`${label}-unreachable`);
    }

    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // Reachable non-success status remains the primary assertion result.
      }
      return { ok: false };
    }

    let text;
    try {
      text = await readBoundedResponse(response, label);
    } catch (error) {
      if (error instanceof SetupError) throw error;
      if (error?.name === 'AbortError') throw new SetupError(`${label}-timeout`);
      throw new SetupError(`${label}-response-failed`);
    }
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      throw new SetupError(`${label}-malformed-json`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function stableVersionFromOutput(output) {
  if (typeof output !== 'string') return undefined;
  const versions = [
    ...output.matchAll(/(?:^|[^0-9A-Za-z.])v?(\d+\.\d+\.\d+)(?![0-9A-Za-z.+-])/g),
  ];
  return versions.length === 1 ? versions[0][1] : undefined;
}

function browserHealthFromOutput(output) {
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  } catch {
    throw new SetupError('browser-health-malformed-output');
  }

  if (!isRecord(parsed)
    || typeof parsed.http_ok !== 'boolean'
    || typeof parsed.json !== 'boolean'
    || typeof parsed.health !== 'boolean') {
    throw new SetupError('browser-health-malformed-output');
  }
  return parsed;
}

function boundedReason(error) {
  const reason = error instanceof SetupError ? error.reason : 'unexpected-driver-error';
  return reason.replace(/[^a-z0-9-]/g, '-').slice(0, 80) || 'unexpected-driver-error';
}

function assertionOutcome(url, checks, failures) {
  return {
    exitCode: 1,
    document: createDocument({
      scenario: 'preflight',
      url,
      ok: false,
      code: 'assertion-failed',
      checks,
      details: {
        assertions: [...new Set(failures)].slice(0, 32),
      },
    }),
  };
}

function setupOutcome(url, checks, error, failures) {
  const details = {
    reason: boundedReason(error),
  };
  if (failures.length > 0) {
    details.assertions = [...new Set(failures)].slice(0, 32);
  }
  return {
    exitCode: 2,
    document: createDocument({
      scenario: 'preflight',
      url,
      ok: false,
      code: 'setup-error',
      checks,
      details,
    }),
  };
}

async function preflightOutcome(url) {
  const checks = {
    arguments: true,
    health_http: false,
    health_json: false,
    readiness_http: false,
    readiness_json: false,
    playwright_cli_invocable: false,
    browser_open: false,
    browser_health_http: false,
    browser_health_json: false,
    browser_cleanup: false,
  };
  const failures = [];
  let outcome;
  let sessionName;
  let closeSession = false;

  try {
    const healthResponse = await fetchJson(new URL('/api/health', url), 'health');
    if (!healthResponse.ok) {
      addAssertion(checks, failures, 'health_http', false);
      return assertionOutcome(url, checks, failures);
    }
    checks.health_http = true;
    checks.health_json = true;
    const health = healthResponse.value;
    addAssertion(checks, failures, 'health_exact', exactObject(health, { status: 'ok' }));

    const readinessResponse = await fetchJson(new URL('/__dtu/readiness.json', url), 'readiness');
    if (!readinessResponse.ok) {
      addAssertion(checks, failures, 'readiness_http', false);
      return assertionOutcome(url, checks, failures);
    }
    checks.readiness_http = true;
    checks.readiness_json = true;
    const readiness = readinessResponse.value;
    const readinessValidation = validateReadiness(readiness);
    Object.assign(checks, readinessValidation.checks);
    failures.push(...readinessValidation.failures);
    if (failures.length > 0) {
      return assertionOutcome(url, checks, failures);
    }

    const versionOutput = runPlaywright(['--version'], 'playwright-version');
    checks.playwright_cli_invocable = true;
    const reportedVersion = stableVersionFromOutput(versionOutput);
    addAssertion(checks, failures, 'playwright_cli_version',
      reportedVersion === PINNED_PLAYWRIGHT_CLI_VERSION);
    if (failures.length > 0) {
      return assertionOutcome(url, checks, failures);
    }

    sessionName = `muxterm-crash-recovery-${randomUUID()}`;
    closeSession = true;
    runPlaywright([`-s=${sessionName}`, 'open', url], 'browser-open');
    checks.browser_open = true;

    const browserHealth = browserHealthFromOutput(
      runPlaywright([`-s=${sessionName}`, '--raw', 'eval', BROWSER_HEALTH_EVALUATION], 'browser-health'),
    );
    addAssertion(checks, failures, 'browser_health_http', browserHealth.http_ok);
    addAssertion(checks, failures, 'browser_health_json', browserHealth.json);
    addAssertion(checks, failures, 'browser_health_exact', browserHealth.health);

    outcome = failures.length === 0
      ? {
        exitCode: 0,
        document: createDocument({
          scenario: 'preflight',
          url,
          ok: true,
          code: 'ok',
          checks,
        }),
      }
      : assertionOutcome(url, checks, failures);
  } catch (error) {
    outcome = setupOutcome(url, checks, error, failures);
  } finally {
    if (closeSession) {
      try {
        runPlaywright([`-s=${sessionName}`, 'close'], 'browser-close');
        checks.browser_cleanup = true;
      } catch (error) {
        checks.browser_cleanup = false;
        if (outcome.exitCode === 0 && outcome.document.ok === true) {
          outcome = setupOutcome(url, checks, error, failures);
        } else {
          const details = outcome.document.details ?? {};
          outcome.document.details = {
            ...details,
            cleanup_error: boundedReason(error),
          };
        }
      }
    }
  }

  return outcome;
}

async function run() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.ok) return invalidArgumentsOutcome(parsed);

  if (parsed.scenario === 'preflight') {
    return preflightOutcome(parsed.url);
  }
  return blockedScenarioOutcome(parsed.scenario, parsed.url);
}

let result;
try {
  result = await run();
} catch (error) {
  result = setupOutcome(undefined, { arguments: false }, error, []);
}

process.stdout.write(`${JSON.stringify(result.document)}\n`);
process.exitCode = result.exitCode;
