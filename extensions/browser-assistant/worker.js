const PAIR_KEY = 'muxtermBrowserPair';
const GRANT_KEY = 'muxtermBrowserGrant';
const PREVIEW_KEY = 'muxtermBrowserPreview';

chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});

async function savedPair() {
  return (await chrome.storage.local.get(PAIR_KEY))[PAIR_KEY];
}

const automation = createAutomation(api, savedPair);

async function api(pair, path, method = 'GET', body) {
  const response = await fetch(`${pair.base}/api/browser-assistant${path}`, {
    method,
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: {'Content-Type': 'application/json', ...(pair.token ? {Authorization: `Bearer ${pair.token}`} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  if (!response.ok) {
    if (response.status === 401 && pair.token) {
      await automation.stop(false);
      await chrome.storage.local.remove(PAIR_KEY);
      await chrome.storage.session.clear();
      await chrome.action.setBadgeText({text: ''});
    }
    throw new Error(`Muxterm returned ${response.status}. ${response.status === 401 ? 'Pair again; the code or connection expired or was revoked.' : 'Check the connection and try again.'}`);
  }
  return response.json();
}

async function poll() {
  const pair = await savedPair();
  if (!pair) return {paired: false, requests: []};
  const result = await api(pair, `/bridge/${pair.id}`);
  const automationStatus = await automation.status();
  await chrome.action.setBadgeText({text: automationStatus.control ? 'ON' : result.requests.length ? String(result.requests.length) : ''});
  const grant = (await chrome.storage.session.get(GRANT_KEY))[GRANT_KEY];
  return {paired: true, base: pair.base, name: pair.name, expiresAt: pair.expiresAt, grant: grant?.expires > Date.now() ? grant : null, requests: result.requests.filter(request => !request.command), ...automationStatus};
}

function snapshotPage(expectedOrigin) {
  if (location.origin !== expectedOrigin) throw new Error('The shared tab changed origin.');
  const text = element => (element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible' && !element.closest('[hidden], [aria-hidden="true"], [contenteditable], input, textarea, select');
  const collect = selector => [...document.querySelectorAll(selector)].filter(visible).slice(0, 60).map(text).filter(Boolean);
  return {
    title: document.title.slice(0, 240),
    url: `${location.origin}${location.pathname}`,
    headings: collect('h1,h2,h3'),
    buttons: collect('button,[role="button"]'),
    links: [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 60).map(element => {
      let target;
      try { target = new URL(element.href); } catch { return ''; }
      if (!['http:', 'https:'].includes(target.protocol)) return '';
      return `${text(element)} — ${target.origin}${target.pathname}`.slice(0, 400);
    }).filter(Boolean),
  };
}

async function checkedGrant() {
  const grant = (await chrome.storage.session.get(GRANT_KEY))[GRANT_KEY];
  if (!grant || grant.expires <= Date.now()) throw new Error('Share a tab first. Tab grants expire after 15 minutes.');
  const tab = await chrome.tabs.get(grant.tabId);
  if (!tab.url || new URL(tab.url).origin !== grant.origin) throw new Error('The tab changed site. Stop sharing and select it again.');
  return {grant, tab};
}

async function handle(message) {
  if (message.action === 'control') { await automation.start(message.tabId, message.managed === true); return poll(); }
  if (message.action === 'current-tab') {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    return tabs.find(tab => tab.url && /^https?:/.test(tab.url) && !tab.incognito) || null;
  }
  if (message.action === 'pair-offer') {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    const tab = tabs[0];
    if (!tab?.url || !/^https?:/.test(tab.url)) return null;
    try {
      const results = await chrome.scripting.executeScript({target: {tabId: tab.id}, func: () => document.body.dataset.muxtermBrowserPairing || ''});
      const raw = results[0]?.result;
      if (!raw || raw.length > 2048) return null;
      const offer = JSON.parse(raw);
      if (new URL(offer.base).origin !== new URL(tab.url).origin || typeof offer.code !== 'string') return null;
      return offer;
    } catch { return null; }
  }
  if (message.action === 'stop-control') { await automation.stop(); return poll(); }
  if (message.action === 'pair') {
    const parsed = new URL(message.base);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Use a plain HTTPS muxterm address.');
    if (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && !message.allowInsecure) throw new Error('LAN HTTP requires explicit acknowledgement. Prefer HTTPS.');
    if (await savedPair()) throw new Error('Disconnect the current instance before pairing another.');
    const pair = {base: parsed.href.replace(/\/$/, ''), name: String(message.name || '').trim()};
    if (!pair.name || pair.name.length > 80) throw new Error('Supply a browser name up to 80 characters.');
    const result = await api(pair, '/claim', 'POST', {code: String(message.code || '').trim(), name: pair.name});
    await chrome.storage.session.clear();
    await chrome.storage.local.set({[PAIR_KEY]: {...pair, ...result}});
    return poll();
  }
  if (message.action === 'status') return poll();
  if (message.action === 'tabs') {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => tab.url && /^https?:/.test(tab.url) && !tab.incognito).map(tab => ({id: tab.id, title: tab.title || tab.url, origin: new URL(tab.url).origin}));
  }
  if (message.action === 'share') {
    if (!await savedPair()) throw new Error('Pair with muxterm first.');
    const tab = await chrome.tabs.get(Number(message.tabId));
    if (!tab.url || !/^https?:/.test(tab.url) || tab.incognito) throw new Error('Choose a normal HTTP or HTTPS tab.');
    const origin = new URL(tab.url).origin;
    await chrome.scripting.executeScript({target: {tabId: tab.id}, func: () => true});
    await chrome.storage.session.set({[GRANT_KEY]: {tabId: tab.id, origin, title: tab.title, expires: Date.now() + 15 * 60000}});
    await chrome.storage.session.remove(PREVIEW_KEY);
    return poll();
  }
  if (message.action === 'stop') {
    await chrome.storage.session.remove([GRANT_KEY, PREVIEW_KEY]);
    return poll();
  }
  if (message.action === 'disconnect') {
    await automation.stop();
    const pair = await savedPair();
    if (pair) await api(pair, `/bridge/${pair.id}`, 'DELETE');
    await chrome.storage.local.remove(PAIR_KEY);
    await chrome.storage.session.clear();
    await chrome.action.setBadgeText({text: ''});
    return {paired: false, requests: []};
  }
  if (message.action === 'forget') {
    await automation.stop(false);
    await chrome.storage.local.remove(PAIR_KEY);
    await chrome.storage.session.clear();
    await chrome.action.setBadgeText({text: ''});
    return {paired: false, requests: []};
  }
  if (['preview', 'approve', 'deny'].includes(message.action)) {
    const status = await poll();
    if (!status.requests.some(request => request.id === message.requestId)) throw new Error('This request expired or was already answered.');
    const pair = await savedPair();
    if (message.action === 'deny') {
      await api(pair, `/bridge/${pair.id}/results/${message.requestId}`, 'POST', {approved: false, snapshot: null});
      await chrome.storage.session.remove(PREVIEW_KEY);
      return poll();
    }
    const {grant, tab} = await checkedGrant();
    if (message.action === 'preview') {
      const results = await chrome.scripting.executeScript({target: {tabId: grant.tabId}, func: snapshotPage, args: [grant.origin]});
      const snapshot = results[0]?.result;
      if (!snapshot) throw new Error('No snapshot could be read.');
      if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 40 * 1024) throw new Error('The page structure is too large for this developer preview.');
      await chrome.storage.session.set({[PREVIEW_KEY]: {requestId: message.requestId, tabId: grant.tabId, url: tab.url, expires: Math.min(grant.expires, Date.now() + 60000), snapshot}});
      return {snapshot};
    }
    const preview = (await chrome.storage.session.get(PREVIEW_KEY))[PREVIEW_KEY];
    if (!preview || preview.requestId !== message.requestId || preview.tabId !== grant.tabId || preview.url !== tab.url || preview.expires <= Date.now()) throw new Error('Preview this request again before sending.');
    await api(pair, `/bridge/${pair.id}/results/${message.requestId}`, 'POST', {approved: true, snapshot: preview.snapshot});
    await chrome.storage.session.remove(PREVIEW_KEY);
    return poll();
  }
  throw new Error('Unknown Browser Assistant operation.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  handle(message).then(result => respond({ok: true, result})).catch(error => respond({ok: false, error: error.message}));
  return true;
});
chrome.alarms.create('muxterm-browser-poll', {periodInMinutes: 0.5});
chrome.alarms.onAlarm.addListener(() => { void automation.tick(); void poll().catch(() => chrome.action.setBadgeText({text: '!'})); });
import {createAutomation} from './automation.js';
