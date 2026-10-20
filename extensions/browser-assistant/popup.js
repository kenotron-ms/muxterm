const element = id => document.getElementById(id);
let state = {instances: [], selected: null, paired: false};
let busy = false;
let refreshing = false;
let revision = 0;
let screen = 'main';
let editing = null;
let target = null;

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Reload Browser Assistant and try again.');
  return response.result;
}

function selected() { return state.instances.find(item => item.key === state.selected); }

function showError(error) {
  element('error').textContent = error.message;
  element('error').hidden = false;
}

function showScreen(next) {
  screen = next;
  for (const name of ['main', 'editor', 'pair', 'remove']) element(`${name}-panel`).hidden = name !== next;
}

function setBusy(value) {
  busy = value;
  for (const control of document.querySelectorAll('button, select, input:not(#access)')) control.disabled = value;
  const hasInstance = Boolean(selected());
  for (const name of ['instances', 'edit', 'remove', 'connect']) element(name).disabled = value || !hasInstance;
  element('access').disabled = value && !state.control && !element('access').checked;
}

async function perform(action) {
  if (busy) return;
  revision++;
  setBusy(true);
  element('error').hidden = true;
  try { await action(); } catch (error) { showError(error); }
  finally { setBusy(false); void refresh(); }
}

function render(status) {
  state = status;
  const options = state.instances.length ? state.instances.map(item => ({key: item.key, label: item.name})) : [{key: '', label: 'Add a Muxterm to get started'}];
  const signature = JSON.stringify(options);
  const picker = element('instances');
  if (picker.dataset.options !== signature) {
    picker.replaceChildren(...options.map(item => new Option(item.label, item.key)));
    picker.dataset.options = signature;
  }
  picker.value = state.selected || '';
  element('instance-url').textContent = selected()?.base || '';
  element('connect').hidden = state.paired;
  element('connected-panel').hidden = !state.paired;
  element('connection-status').textContent = state.offline ? 'Cannot reach Muxterm · retrying' : 'Connected';
  element('connection-status').classList.toggle('offline', Boolean(state.offline));
  element('access').checked = Boolean(state.control);
  element('control-status').textContent = state.control ? 'Active · no time limit' : 'Paused';
  element('scope').textContent = state.control ? `${state.tabCount} managed ${state.tabCount === 1 ? 'tab' : 'tabs'} · only this window is controlled` : 'Paused · Your browser is private.';
  element('activity').textContent = state.control ? state.activity || 'Ready for your agents.' : '';
  setBusy(busy);
}

async function refresh() {
  if (busy || refreshing) return;
  refreshing = true;
  const started = revision;
  try {
    const status = await send({action: 'status'});
    if (!busy && started === revision) render(status);
  } catch (error) { if (!busy && started === revision) showError(error); }
  finally { refreshing = false; }
}

function insecure(base) {
  try {
    const parsed = new URL(base);
    return parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch { return false; }
}

function openEditor(item) {
  editing = item?.key || null;
  element('editor-title').textContent = item ? 'Edit Muxterm' : 'Add Muxterm';
  element('name').value = item?.name || '';
  element('base').value = item?.base || '';
  element('insecure').checked = item?.allowInsecure || false;
  element('insecure-warning').hidden = !insecure(element('base').value);
  element('edit-warning').hidden = !item;
  showScreen('editor');
  element('name').focus();
}

function openPair(item) {
  target = item.key;
  element('pair-title').textContent = `Connect to ${item.name}`;
  element('code').value = '';
  showScreen('pair');
  element('code').focus();
}

element('add').addEventListener('click', () => openEditor());
element('edit').addEventListener('click', () => openEditor(selected()));
element('base').addEventListener('input', () => { element('insecure-warning').hidden = !insecure(element('base').value); element('insecure').checked = false; });
for (const action of ['edit', 'pair', 'remove']) element(`cancel-${action}`).addEventListener('click', () => { element('code').value = ''; showScreen('main'); });
element('instance-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    render(await send({action: 'save', key: editing, name: element('name').value, base: element('base').value, allowInsecure: element('insecure').checked}));
    showScreen('main');
  });
});
element('instances').addEventListener('change', event => {
  const key = event.target.value;
  void perform(async () => render(await send({action: 'select', key})));
});
element('connect').addEventListener('click', () => void perform(async () => {
  const item = selected();
  const parsed = new URL(item.base);
  if (!await chrome.permissions.request({origins: [`${parsed.protocol}//${parsed.hostname}/*`]})) throw new Error('Connection permission declined.');
  const status = await send({action: 'connect', key: item.key});
  render(status);
  if (status.needsPair) openPair(item);
}));
element('pair-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    const status = await send({action: 'pair', key: target, code: element('code').value});
    render(status);
    element('code').value = '';
    if (status.needsPair) throw new Error('Pairing expired. Create a fresh code in Muxterm.');
    showScreen('main');
  });
});
element('disconnect').addEventListener('click', () => void perform(async () => render(await send({action: 'disconnect'}))));
element('remove').addEventListener('click', () => {
  target = selected().key;
  element('remove-description').textContent = `${selected().name} · ${selected().base}`;
  showScreen('remove');
});
element('confirm-remove').addEventListener('click', () => void perform(async () => {
  render(await send({action: 'remove', key: target}));
  showScreen('main');
}));
element('access').addEventListener('change', () => {
  if (!element('access').checked) {
    revision++;
    void send({action: 'stop-control'}).then(render).catch(showError);
  } else {
    void perform(async () => {
      try { render(await send({action: 'control'})); }
      catch (error) { element('access').checked = false; throw error; }
    });
  }
});

try { render(await send({action: 'local-status'})); } catch (error) { showError(error); }
void refresh();
setInterval(() => { void refresh(); }, 3000);
