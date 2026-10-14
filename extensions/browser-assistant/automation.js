const CONTROL_KEY = 'muxtermBrowserControl';

function inspectPage() {
  const visible = element => element.getClientRects().length && getComputedStyle(element).visibility === 'visible' && !element.closest('[hidden],[aria-hidden="true"]');
  const selectorFor = element => {
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 12) {
      const siblings = [...current.parentElement.children].filter(candidate => candidate.tagName === current.tagName);
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  return {
    title: document.title, url: location.href,
    text: (document.body?.innerText || '').slice(0, 16000),
    elements: [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(visible).slice(0, 100).map(element => {
      const rectangle = element.getBoundingClientRect();
      return {selector: selectorFor(element), tag: element.tagName.toLowerCase(), type: element.getAttribute('type'), label: (element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.innerText || '').slice(0, 240), x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2};
    }),
  };
}

export function createAutomation(api, savedPair) {
  let running = false;
  let generation = 0;
  let lastActivity = 'No browser actions yet.';
  const assertGeneration = expected => {
    if (generation !== expected) throw new Error('Browser access was paused or replaced.');
  };
  const dispatch = async (tabId, method, params, controlId, expectedGeneration) => {
    const control = await checked(controlId, expectedGeneration);
    if (control.tabId !== tabId) throw new Error('The authorized tab changed.');
    assertGeneration(expectedGeneration);
    return chrome.debugger.sendCommand({tabId}, method, params);
  };
  const stored = async () => (await chrome.storage.session.get(CONTROL_KEY))[CONTROL_KEY];
  const loadedTab = async tabId => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && /^https?:/.test(tab.url)) return tab;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Browser tab did not load an HTTP or HTTPS page.');
  };
  const recovery = stop(true, false).catch(() => {});

  async function stop(notify = true, invalidate = true) {
    if (invalidate) generation++;
    const control = await stored();
    await chrome.storage.session.remove(CONTROL_KEY);
    if (control) await chrome.debugger.detach({tabId: control.tabId}).catch(() => {});
    await chrome.action.setBadgeText({text: ''});
    if (notify) {
      const pair = await savedPair();
      if (pair) await api(pair, `/bridge/${pair.id}/control`, 'POST', {active: false});
    }
  }

  async function checked(expectedId, expectedGeneration = generation) {
    assertGeneration(expectedGeneration);
    const control = await stored();
    assertGeneration(expectedGeneration);
    if (!control || control.generation !== expectedGeneration || (expectedId && expectedId !== control.id)) throw new Error('Browser access is paused. Turn it on in the extension.');
    const tab = await chrome.tabs.get(control.tabId);
    assertGeneration(expectedGeneration);
    if (tab.incognito || !tab.url || !/^https?:/.test(tab.url) || (control.managed ? tab.windowId !== control.windowId : new URL(tab.url).origin !== control.origin)) throw new Error('Tab left the authorized browser workspace.');
    return control;
  }

  async function start(tabId, managed = false) {
    const startingGeneration = ++generation;
    await recovery;
    assertGeneration(startingGeneration);
    const pair = await savedPair();
    assertGeneration(startingGeneration);
    if (!pair) throw new Error('Pair with muxterm first.');
    await stop(true, false);
    assertGeneration(startingGeneration);
    if (managed) {
      const window = await chrome.windows.create({url: `${pair.base}/api/browser-assistant/workspace`, focused: true});
      tabId = window.tabs[0].id;
    }
    const tab = managed ? await loadedTab(Number(tabId)) : await chrome.tabs.get(Number(tabId));
    if (!tab.url || !/^https?:/.test(tab.url) || tab.incognito) throw new Error('Choose a normal HTTP or HTTPS tab.');
    const origin = new URL(tab.url).origin;
    if (generation !== startingGeneration) throw new Error('Browser access was paused.');
    await chrome.debugger.attach({tabId: tab.id}, '1.3');
    try {
      if (generation !== startingGeneration) throw new Error('Browser access was paused.');
      const response = await api(pair, `/bridge/${pair.id}/control`, 'POST', {active: true, origin, managed});
      if (generation !== startingGeneration) {
        await api(pair, `/bridge/${pair.id}/control`, 'POST', {active: false});
        throw new Error('Browser access was paused.');
      }
      await chrome.storage.session.set({[CONTROL_KEY]: {tabId: tab.id, windowId: tab.windowId, managed, origin, id: response.control.id, generation: startingGeneration}});
      if (generation !== startingGeneration) { await stop(); throw new Error('Browser access was paused.'); }
      await chrome.action.setBadgeBackgroundColor({color: '#b43232'});
      await chrome.action.setBadgeText({text: 'ON'});
      lastActivity = 'Control authorized locally. Waiting for agent commands.';
    } catch (error) { await chrome.debugger.detach({tabId: tab.id}).catch(() => {}); throw error; }
  }

  async function evaluate(tabId, expression, controlId, expectedGeneration) {
    const control = await checked(controlId, expectedGeneration);
    const guarded = `(() => { if(${control.managed ? "!['http:', 'https:'].includes(location.protocol)" : `location.origin !== ${JSON.stringify(control.origin)}`}) throw new Error('Tab left authorized workspace'); return (${expression}); })()`;
    const frames = await dispatch(tabId, 'Page.getFrameTree', {}, controlId, expectedGeneration);
    const world = await dispatch(tabId, 'Page.createIsolatedWorld', {frameId: frames.frameTree.frame.id, worldName: 'muxterm-browser-assistant'}, controlId, expectedGeneration);
    const response = await dispatch(tabId, 'Runtime.evaluate', {expression: guarded, contextId: world.executionContextId, returnByValue: true}, controlId, expectedGeneration);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Page inspection failed.');
    return response.result.value;
  }

  async function execute(request) {
    const executionGeneration = generation;
    const control = await checked(request.controlId, executionGeneration);
    const command = (tabId, method, params = {}) => dispatch(tabId, method, params, request.controlId, executionGeneration);
    const tabId = control.tabId;
    const action = request.command;
    const managedTabs = async () => (await chrome.tabs.query({windowId: control.windowId})).filter(tab => !tab.incognito && tab.url && /^https?:/.test(tab.url));
    const switchTab = async tab => {
      if (!control.managed || tab.windowId !== control.windowId || tab.incognito || !tab.url || !/^https?:/.test(tab.url)) throw new Error('Choose a normal tab in the managed browser window.');
      const switchingGeneration = executionGeneration;
      await checked(request.controlId, executionGeneration);
      if (generation !== switchingGeneration) throw new Error('Browser access was paused.');
      if (tab.id === tabId) return {tabId, url: tab.url};
      await chrome.storage.session.set({[CONTROL_KEY]: {...control, tabId: tab.id}});
      await chrome.debugger.detach({tabId}).catch(() => {});
      assertGeneration(switchingGeneration);
      await chrome.debugger.attach({tabId: tab.id}, '1.3');
      if (generation !== switchingGeneration) { await chrome.debugger.detach({tabId: tab.id}).catch(() => {}); throw new Error('Browser access was paused.'); }
      return {tabId: tab.id, url: tab.url};
    };
    const point = async () => {
      if (action.selector) {
        const result = await evaluate(tabId, `(() => { const element = document.querySelector(${JSON.stringify(action.selector)}); if (!element) throw new Error('Selector not found'); element.scrollIntoView({block:'center',inline:'center'}); const rectangle = element.getBoundingClientRect(); if (!rectangle.width || !rectangle.height) throw new Error('Element not visible'); element.focus(); return {x:rectangle.x+rectangle.width/2,y:rectangle.y+rectangle.height/2}; })()`, request.controlId, executionGeneration);
        return result;
      }
      return {x: action.x || 0, y: action.y || 0};
    };
    switch (action.action) {
      case 'tabs': return {tabs: control.managed ? (await managedTabs()).map(tab => ({tabId: tab.id, title: tab.title, url: tab.url, selected: tab.id === tabId})) : [{tabId, url: (await chrome.tabs.get(tabId)).url, selected: true}]};
      case 'select_tab': return switchTab(await chrome.tabs.get(action.tabId));
      case 'new_tab': {
        if (!control.managed) throw new Error('New tabs require the managed browser window.');
        const target = new URL(action.url);
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use a normal HTTP or HTTPS address.');
        await checked(request.controlId, executionGeneration);
        assertGeneration(executionGeneration);
        const created = await chrome.tabs.create({windowId: control.windowId, url: target.href, active: true});
        return switchTab(await loadedTab(created.id));
      }
      case 'inspect': return evaluate(tabId, `(${inspectPage.toString()})()`, request.controlId, executionGeneration);
      case 'screenshot': {
        const result = await command(tabId, 'Page.captureScreenshot', {format: 'jpeg', quality: 60, captureBeyondViewport: false});
        if (result.data.length > 1800000) throw new Error('Screenshot too large. Reduce the browser window size.');
        return {mimeType: 'image/jpeg', data: result.data};
      }
      case 'navigate': {
        const target = new URL(action.url);
        if (!['http:', 'https:'].includes(target.protocol) || (!control.managed && target.origin !== control.origin) || target.username || target.password) throw new Error('Navigation requires an authorized HTTP/HTTPS site and no URL credentials.');
        const result = await command(tabId, 'Page.navigate', {url: target.href});
        if (result.errorText) throw new Error(result.errorText);
        return {navigated: target.href};
      }
      case 'click': {
        const location = await point();
        await checked(request.controlId, executionGeneration);
        await command(tabId, 'Input.dispatchMouseEvent', {type: 'mousePressed', ...location, button: 'left', clickCount: 1});
        await command(tabId, 'Input.dispatchMouseEvent', {type: 'mouseReleased', ...location, button: 'left', clickCount: 1});
        return {clicked: true};
      }
      case 'type':
        if (action.selector) await point();
        await checked(request.controlId, executionGeneration);
        if (typeof action.text !== 'string') throw new Error('Supply text to insert.');
        await command(tabId, 'Input.insertText', {text: action.text});
        return {typed: true};
      case 'key': {
        const keys = {Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, Delete: 46};
        if (!Object.hasOwn(keys, action.key)) throw new Error('Unsupported key.');
        await command(tabId, 'Input.dispatchKeyEvent', {type: 'keyDown', key: action.key, windowsVirtualKeyCode: keys[action.key], ...(action.key === 'Enter' ? {text: '\r'} : {})});
        await command(tabId, 'Input.dispatchKeyEvent', {type: 'keyUp', key: action.key, windowsVirtualKeyCode: keys[action.key]});
        return {pressed: action.key};
      }
      case 'scroll':
        await command(tabId, 'Input.dispatchMouseEvent', {type: 'mouseWheel', x: action.x || 100, y: action.y || 100, deltaX: action.deltaX || 0, deltaY: action.deltaY || 0});
        return {scrolled: true};
      default: throw new Error('Unsupported browser action.');
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      if (!await stored()) return;
      const control = await checked();
      const pair = await savedPair();
      if (!pair) { await stop(false); return; }
      const status = await api(pair, `/bridge/${pair.id}`);
      if (status.control?.id !== control.id) { await stop(false); return; }
      const request = status.requests.find(candidate => candidate.command && candidate.controlId === control.id);
      if (!request) return;
      await api(pair, `/bridge/${pair.id}/commands/${request.id}/start`, 'POST', {});
      lastActivity = `${request.command.action}: ${request.reason}`;
      let result = null;
      let error = '';
      try { result = await execute(request); } catch (failure) { error = failure.message.slice(0, 1000); }
      await checked(request.controlId);
      await api(pair, `/bridge/${pair.id}/commands/${request.id}/result`, 'POST', {result, error});
    } catch (error) {
      lastActivity = `Paused: ${error.message}`;
      await stop().catch(() => {});
    } finally { running = false; }
  }

  chrome.debugger.onDetach.addListener(source => { void stored().then(control => { if (control?.tabId === source.tabId) return stop(); }).catch(() => {}); });
  chrome.tabs.onRemoved.addListener(tabId => { void stored().then(control => { if (control?.tabId === tabId) return stop(); }).catch(() => {}); });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (!change.url) return;
    void stored().then(control => { if (control?.tabId === tabId && (!/^https?:/.test(change.url) || (!control.managed && new URL(change.url).origin !== control.origin))) return stop(); }).catch(() => {});
  });
  setInterval(() => { void tick(); }, 1000);
  return {start, stop, tick, status: async () => {
    const control = await stored();
    const tabs = control?.managed ? await chrome.tabs.query({windowId: control.windowId}).catch(() => []) : [];
    return {control, tabCount: control ? (control.managed ? tabs.filter(tab => /^https?:/.test(tab.url || '')).length : 1) : 0, activity: lastActivity};
  }};
}
