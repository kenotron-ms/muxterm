const element = id => document.getElementById(id);
let busy = false;
let offer = null;

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Reload Browser Assistant and try again.');
  return response.result;
}

function showError(error) {
  element('error').textContent = error.message;
  element('error').hidden = false;
}

async function perform(action) {
  if (busy) return;
  busy = true;
  element('error').hidden = true;
  try { await action(); } catch (error) { showError(error); }
  finally { busy = false; }
}

function render(status) {
  element('pair-panel').hidden = status.paired;
  element('connected-panel').hidden = !status.paired;
  element('access').checked = Boolean(status.control);
  if (!status.paired) return;
  element('connection-name').textContent = status.name;
  element('instance').textContent = new URL(status.base).host;
  element('control-status').textContent = status.control ? 'Active · no time limit' : 'Paused';
  element('scope').textContent = status.control ? status.control.managed ? `${status.tabCount} managed ${status.tabCount === 1 ? 'tab' : 'tabs'} · only this window is controlled` : `This tab only · ${status.control.origin}` : 'Turn on to open a dedicated browser window for your agents.';
  element('activity').textContent = status.control ? status.activity || 'Ready for your agents.' : 'Pairing stays connected while access is paused.';
}

function insecure(base) {
  const parsed = new URL(base);
  return parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
}

async function pair(base, name, code, allowInsecure) {
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Use a plain HTTP or HTTPS Muxterm address.');
  if (insecure(base) && !allowInsecure) throw new Error('Confirm insecure LAN HTTP, or use HTTPS.');
  if (!await chrome.permissions.request({origins: [`${parsed.protocol}//${parsed.hostname}/*`]})) throw new Error('Connection permission declined.');
  render(await send({action: 'pair', base: parsed.href, name, code, allowInsecure}));
  element('code').value = '';
  offer = null;
}

async function refresh() {
  const status = await send({action: 'status'});
  render(status);
  if (!status.paired) {
    offer = await send({action: 'pair-offer'});
    element('offer-panel').hidden = !offer;
    if (offer) {
      element('offer-origin').textContent = `Connect to ${new URL(offer.base).host}`;
      element('offer-warning').hidden = !insecure(offer.base);
    }
  }
}

element('pair-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform(() => pair(element('base').value, element('name').value, element('code').value, element('insecure').checked));
});
element('connect').addEventListener('click', () => void perform(async () => {
  if (!offer) throw new Error('Create a fresh pairing request in Muxterm.');
  await pair(offer.base, 'My browser', offer.code, element('offer-insecure').checked);
}));
element('access').addEventListener('change', () => {
  if (!element('access').checked) {
    void send({action: 'stop-control'}).then(render).catch(showError);
  } else {
    void perform(async () => {
      try { render(await send({action: 'control', managed: true})); }
      catch (error) { element('access').checked = false; throw error; }
    });
  }
});
element('use-tab').addEventListener('click', () => void perform(async () => {
  const tab = await send({action: 'current-tab'});
  if (!tab) throw new Error('Open this extension from the HTTP or HTTPS tab you want to use.');
  render(await send({action: 'control', tabId: tab.id}));
}));
for (const action of ['disconnect', 'forget']) element(action).addEventListener('click', () => void perform(async () => render(await send({action}))));
await perform(refresh);
setInterval(() => { if (!busy) void perform(refresh); }, 3000);
