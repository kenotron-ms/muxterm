import {createAutomation} from './automation.js';

const PAIR_KEY = 'muxtermBrowserPair';
const INSTANCES_KEY = 'muxtermBrowserInstances';
let instances;
let writes = Promise.resolve();
let operations = Promise.resolve();
let pending = 0;
const ready = initialize();
const automation = createAutomation(api, savedPair);

async function initialize() {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  await chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  const stored = await chrome.storage.local.get([PAIR_KEY, INSTANCES_KEY]);
  instances = stored[INSTANCES_KEY] || {items: [], selected: null};
  if (!stored[INSTANCES_KEY] && stored[PAIR_KEY]) {
    const pair = stored[PAIR_KEY];
    const key = crypto.randomUUID();
    instances = {selected: key, items: [{key, name: pair.name || new URL(pair.base).host, base: pair.base, allowInsecure: insecure(pair.base), pair: {id: pair.id, token: pair.token}}]};
    await persist();
  }
}

function persist() {
  writes = writes.catch(() => {}).then(() => chrome.storage.local.set({[INSTANCES_KEY]: instances}));
  return writes;
}

async function savedPair() {
  await ready;
  return (await chrome.storage.local.get(PAIR_KEY))[PAIR_KEY];
}

function insecure(base) {
  const parsed = new URL(base);
  return parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
}

function entry(key = instances.selected) {
  const item = instances.items.find(candidate => candidate.key === key);
  if (!item) throw new Error('Choose a saved Muxterm first.');
  return item;
}

function samePair(first, second) {
  return Boolean(first && second && first.base === second.base && first.id === second.id && first.token === second.token);
}

async function api(pair, path, method = 'GET', body) {
  const response = await fetch(`${pair.base}/api/browser-assistant${path}`, {
    method, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: {'Content-Type': 'application/json', ...(pair.token ? {Authorization: `Bearer ${pair.token}`} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  if (!response.ok) {
    if (response.status === 401 && pair.token) {
      const current = await savedPair();
      if (samePair(current, pair)) {
        await automation.stop(false);
        await chrome.storage.local.remove(PAIR_KEY);
        await chrome.storage.session.clear();
        await chrome.action.setBadgeText({text: ''});
      }
      for (const item of instances.items) {
        if (item.base === pair.base && item.pair?.id === pair.id && item.pair?.token === pair.token) delete item.pair;
      }
      await persist();
    }
    throw new Error(`Muxterm returned ${response.status}. ${response.status === 401 ? 'Create a fresh pairing code in Muxterm.' : 'Check the connection and try again.'}`);
  }
  return response.json();
}

async function localStatus(extra = {}) {
  await ready;
  const pair = await savedPair();
  return {
    instances: instances.items.map(item => ({key: item.key, name: item.name, base: item.base, allowInsecure: item.allowInsecure, hasPair: Boolean(item.pair)})),
    selected: instances.selected,
    paired: Boolean(pair),
    ...(pair ? {base: pair.base, name: pair.name} : {}),
    ...await automation.status(), ...extra,
  };
}

async function poll() {
  const pair = await savedPair();
  if (!pair) return localStatus();
  try {
    await api(pair, `/bridge/${pair.id}`);
    if (!samePair(await savedPair(), pair)) return localStatus();
    const status = await localStatus();
    await chrome.action.setBadgeText({text: status.control ? 'ON' : ''});
    return status;
  } catch (error) {
    if (!samePair(await savedPair(), pair)) return localStatus();
    await chrome.action.setBadgeText({text: '!'});
    return localStatus({offline: true, connectionError: error.message});
  }
}

async function disconnect() {
  await automation.stop().catch(() => {});
  await chrome.storage.local.remove(PAIR_KEY);
  await chrome.storage.session.clear();
  await chrome.action.setBadgeText({text: ''});
}

async function mutate(message) {
  await ready;
  if (message.action === 'save') {
    const parsed = new URL(message.base);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.href.length > 2048) throw new Error('Use a plain HTTP or HTTPS Muxterm URL.');
    const base = parsed.href.replace(/\/+$/, '');
    if (insecure(base) && message.allowInsecure !== true) throw new Error('Confirm insecure LAN HTTP, or use HTTPS.');
    const name = String(message.name || '').trim();
    if (!name || name.length > 80) throw new Error('Enter a name up to 80 characters.');
    if (instances.items.some(item => item.base === base && item.key !== message.key)) throw new Error('That Muxterm URL is already saved.');
    const existing = message.key ? entry(message.key) : null;
    if (!existing && instances.items.length >= 50) throw new Error('You can save up to 50 instances.');
    if (existing && existing.base !== base) {
      if (instances.selected === existing.key) await disconnect();
      delete existing.pair;
    }
    const item = existing || {key: crypto.randomUUID()};
    Object.assign(item, {name, base, allowInsecure: insecure(base) && message.allowInsecure === true});
    if (!existing) {
      await disconnect();
      instances.items.push(item);
      instances.selected = item.key;
    }
    await persist();
    return localStatus();
  }
  if (message.action === 'select') {
    const item = entry(message.key);
    if (instances.selected !== item.key) await disconnect();
    instances.selected = item.key;
    await persist();
    return localStatus();
  }
  if (message.action === 'remove') {
    const item = entry(message.key);
    if (instances.selected === item.key) await disconnect();
    instances.items = instances.items.filter(candidate => candidate.key !== item.key);
    if (instances.selected === item.key) instances.selected = instances.items[0]?.key || null;
    await persist();
    return localStatus();
  }
  if (message.action === 'disconnect') {
    await disconnect();
    return localStatus();
  }
  if (message.action === 'connect' || message.action === 'pair') {
    const item = entry(message.key);
    await disconnect();
    instances.selected = item.key;
    await persist();
    const parsed = new URL(item.base);
    if (!await chrome.permissions.contains({origins: [`${parsed.protocol}//${parsed.hostname}/*`]})) throw new Error('Allow this Muxterm hostname before connecting.');
    if (message.action === 'pair') {
      const code = String(message.code || '').trim();
      if (!code || code.length > 256) throw new Error('Enter a fresh pairing code from Muxterm.');
      const result = await api(item, '/claim', 'POST', {code, name: 'My browser'});
      if (!/^[A-Za-z0-9_-]{16}$/.test(result.id || '') || !/^[A-Za-z0-9_-]{43}$/.test(result.token || '')) throw new Error('Muxterm returned invalid pairing credentials.');
      item.pair = {id: result.id, token: result.token};
      await persist();
    }
    if (!item.pair) return localStatus({needsPair: true});
    await chrome.storage.local.set({[PAIR_KEY]: {base: item.base, name: item.name, ...item.pair}});
    const status = await poll();
    return {...status, needsPair: !status.paired};
  }
  throw new Error('Unknown Browser Assistant operation.');
}

async function handle(message) {
  if (message.action === 'status') return poll();
  if (message.action === 'local-status') return localStatus();
  if (message.action === 'stop-control') {
    await automation.stop().catch(() => {});
    return localStatus();
  }
  if (message.action === 'control') {
    if (pending) throw new Error('Wait for the instance change to finish before enabling access.');
    await automation.start(undefined, true);
    return poll();
  }
  pending++;
  const operation = operations.then(() => mutate(message)).finally(() => { pending--; });
  operations = operation.catch(() => {});
  return operation;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  handle(message).then(result => respond({ok: true, result})).catch(error => respond({ok: false, error: error.message}));
  return true;
});
chrome.alarms.create('muxterm-browser-poll', {periodInMinutes: 0.5});
chrome.alarms.onAlarm.addListener(() => { void automation.tick(); void poll().catch(() => chrome.action.setBadgeText({text: '!'})); });
