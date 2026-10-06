(() => {
  if (window.__muxtermDesktopBrowser) return;
  window.__muxtermDesktopBrowser = true;
  const send = (message) => window.webkit.messageHandlers.external.postMessage('muxterm.desktop:' + JSON.stringify(message));
  const start = () => {
    if (!document.querySelector('mux-app')) return;
    const style = document.createElement('style');
    style.textContent = `
      :root { --muxterm-browser-width: 0px; }
      mux-app { width: calc(100vw - var(--muxterm-browser-width)) !important; }
      #muxterm-browser-launch { position: fixed; z-index: 9998; top: 7px; right: 9px; border: 1px solid #596273; border-radius: 7px; background: #272d38; color: white; padding: 7px 12px; font: 12px -apple-system, sans-serif; cursor: pointer; box-shadow: 0 2px 8px #0008; }
      #muxterm-browser-panel { position: fixed; z-index: 9997; top: 0; right: 0; bottom: 0; width: var(--muxterm-browser-width); display: none; flex-direction: column; background: #f7f7f8; color: #1c1c1e; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; box-shadow: -1px 0 #b9bcc3; }
      #muxterm-browser-panel.open { display: flex; }
      #muxterm-browser-grip { position: absolute; left: -4px; top: 0; bottom: 0; width: 7px; cursor: col-resize; }
      #muxterm-browser-tabs { height: 40px; flex: none; display: flex; align-items: center; gap: 3px; padding: 6px 7px; background: #ededf0; overflow-x: auto; }
      #muxterm-browser-tabs button { flex: none; border: 0; background: transparent; color: #34363b; font: inherit; cursor: pointer; border-radius: 7px; height: 27px; padding: 0 9px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #muxterm-browser-tabs button.selected { background: white; box-shadow: 0 1px 3px #0002; }
      #muxterm-browser-tabs button.new { font-size: 20px; line-height: 20px; }
      #muxterm-browser-tabs button.close { width: 22px; padding: 0; margin-left: -25px; font-size: 16px; }
      #muxterm-browser-nav { height: 45px; flex: none; display: flex; gap: 4px; align-items: center; padding: 5px 8px; border-bottom: 1px solid #d7d8dc; background: #fff; }
      #muxterm-browser-nav button { flex: none; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: #373b44; font: 17px -apple-system, sans-serif; cursor: pointer; }
      #muxterm-browser-nav button:hover, #muxterm-browser-tabs button:hover { background: #e7e8eb; }
      #muxterm-browser-nav button:disabled { opacity: .35; cursor: default; }
      #muxterm-browser-address { min-width: 0; flex: 1; height: 30px; border-radius: 16px; border: 1px solid #e2e2e5; background: #f7f7f8; color: #24262b; text-align: center; padding: 0 12px; font: 12px -apple-system, sans-serif; outline: none; }
      #muxterm-browser-address:focus { text-align: left; border-color: #5799dc; }
      #muxterm-browser-content { flex: 1; min-height: 0; background: #fff; }
      #muxterm-browser-status { min-height: 18px; padding: 2px 9px; color: #a32632; background: #fff; font-size: 11px; display: none; }
      #muxterm-browser-status:not(:empty) { display: block; }
    `;
    document.head.append(style);
    const launch = document.createElement('button');
    launch.id = 'muxterm-browser-launch';
    launch.type = 'button';
    launch.textContent = 'Browser';
    launch.title = 'Open browser panel';
    const panel = document.createElement('aside');
    panel.id = 'muxterm-browser-panel';
    panel.setAttribute('aria-label', 'Browser panel');
    panel.innerHTML = '<div id="muxterm-browser-grip"></div><div id="muxterm-browser-tabs"></div><div id="muxterm-browser-nav"><button id="muxterm-browser-back" title="Back">‹</button><button id="muxterm-browser-forward" title="Forward">›</button><button id="muxterm-browser-reload" title="Reload">↻</button><input id="muxterm-browser-address" aria-label="Address" placeholder="http://localhost:3000/"><button id="muxterm-browser-external" title="Open in Mac browser">↗</button><button id="muxterm-browser-expand" title="Expand browser">⛶</button><button id="muxterm-browser-hide" title="Hide browser">×</button></div><div id="muxterm-browser-content"></div><div id="muxterm-browser-status" role="status"></div>';
    document.body.append(launch, panel);
    const $ = (id) => panel.querySelector('#muxterm-browser-' + id);
    const address = $('address');
    const status = $('status');
    let open = false;
    let expanded = false;
    let width = Math.min(600, Math.max(400, window.innerWidth * .42));
    let active = 0;
    let createNew = false;
    let tabs = [];
    const layout = () => {
      const r = $('content').getBoundingClientRect();
      send({type: 'layout', visible: open, rect: {X: r.x, Y: r.y, Width: r.width, Height: r.height}});
    };
    const setOpen = (value) => {
      open = value;
      document.documentElement.style.setProperty('--muxterm-browser-width', open ? (expanded ? '100vw' : Math.min(width, window.innerWidth - 320) + 'px') : '0px');
      panel.classList.toggle('open', open);
      launch.style.display = open ? 'none' : '';
      requestAnimationFrame(layout);
    };
    window.__muxtermDesktopOpenPanel = () => setOpen(true);
    const error = (message) => { status.textContent = message || ''; };
    const navigate = () => {
      let value = address.value.trim();
      if (!value) return;
      if (!/^[a-z]+:\/\//i.test(value)) value = 'http://' + value;
      if (active && !createNew) send({type: 'navigate', id: active, url: value});
      else send({type: 'open', url: value});
      createNew = false;
      error('');
    };
    launch.addEventListener('click', () => setOpen(true));
    $('hide').addEventListener('click', () => setOpen(false));
    $('expand').addEventListener('click', () => { expanded = !expanded; $('expand').title = expanded ? 'Dock browser right' : 'Expand browser'; setOpen(true); });
    $('back').addEventListener('click', () => send({type: 'back', id: active}));
    $('forward').addEventListener('click', () => send({type: 'forward', id: active}));
    $('reload').addEventListener('click', () => send({type: 'reload', id: active}));
    $('external').addEventListener('click', () => { const value = address.value.trim(); if (value) send({type: 'external', url: value}); });
    address.addEventListener('keydown', (event) => { if (event.key === 'Enter') { navigate(); address.blur(); } });
    window.addEventListener('resize', () => { if (open) setOpen(true); });
    new ResizeObserver(layout).observe($('content'));
    let dragging = false;
    $('grip').addEventListener('pointerdown', (event) => { dragging = true; event.target.setPointerCapture(event.pointerId); });
    $('grip').addEventListener('pointermove', (event) => { if (!dragging) return; expanded = false; width = Math.max(320, Math.min(window.innerWidth - 320, window.innerWidth - event.clientX)); setOpen(true); });
    $('grip').addEventListener('pointerup', () => { dragging = false; });
    window.__muxtermDesktopReceive = (state) => {
      if (state.error) error(state.error);
      if (!state.tabs) return;
      tabs = state.tabs;
      active = state.active;
      const strip = $('tabs');
      strip.replaceChildren();
      for (const tab of tabs) {
        const button = document.createElement('button');
        button.type = 'button';
        button.classList.toggle('selected', tab.id === active);
        button.title = tab.url;
        button.textContent = tab.title || tab.url || 'New tab';
        button.addEventListener('click', () => send({type: 'select', id: tab.id}));
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'close';
        close.title = 'Close tab';
        close.textContent = '×';
        close.addEventListener('click', () => send({type: 'close', id: tab.id}));
        strip.append(button, close);
      }
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.className = 'new';
      plus.textContent = '+';
      plus.title = 'New tab';
      plus.addEventListener('click', () => { createNew = true; address.value = 'http://localhost:3000/'; address.focus(); address.select(); });
      strip.append(plus);
      const current = tabs.find((tab) => tab.id === active);
      if (document.activeElement !== address) address.value = current?.url || '';
      $('back').disabled = !current?.canGoBack;
      $('forward').disabled = !current?.canGoForward;
    };
    setInterval(() => { if (open) send({type: 'status'}); }, 700);
    setOpen(false);
  };
  const waitForApp = () => {
    if (document.querySelector('mux-app')) { start(); return; }
    const observer = new MutationObserver(() => {
      if (!document.querySelector('mux-app')) return;
      observer.disconnect();
      start();
    });
    observer.observe(document.documentElement, {childList: true, subtree: true});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForApp, {once: true});
  else waitForApp();
})();
