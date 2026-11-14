(() => {
  if (window.__muxtermDesktopBrowser) return;
  window.__muxtermDesktopBrowser = {
    send(message) {
      window.webkit.messageHandlers.external.postMessage('muxterm.desktop:' + JSON.stringify(message));
    },
  };
  window.__muxtermDesktopReceive = (state) => {
    window.dispatchEvent(new CustomEvent('muxterm-browser-state', { detail: state }));
  };
  const externalURL = (raw) => {
    if ((typeof raw !== 'string' && !(raw instanceof URL)) || !String(raw).trim()) return null;
    try {
      const url = new URL(raw, document.baseURI);
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url : null;
    } catch {
      return null;
    }
  };
  const openExternal = (raw) => {
    const url = externalURL(raw);
    if (!url) return false;
    window.__muxtermDesktopBrowser.send({ type: 'external', url: url.href });
    return true;
  };
  // WebKit does not create a browser window for new-tab links. Handle links
  // across the app, including links inside Lit shadow roots, while keeping
  // same-origin navigation in the muxterm window.
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
    if (!anchor) return;
    const url = externalURL(anchor.href);
    if (!url || (anchor.target.toLowerCase() !== '_blank' && url.protocol !== 'mailto:' && url.origin === window.location.origin)) return;
    event.preventDefault();
    openExternal(url.href);
  });
  // xterm's WebLinksAddon and file actions use window.open instead of anchors.
  // Leave blob URLs and other schemes with WebKit, where their data exists.
  const webkitOpen = window.open;
  window.open = function (url, target, features) {
    if ((!target || String(target).toLowerCase() === '_blank') && openExternal(url)) return null;
    return webkitOpen.call(window, url, target, features);
  };
  // The server page lives in its own origin, so Wails' drag helper is not
  // available here. Ask the native window to drag only from empty chrome.
  let dragStart = null;
  const isChrome = (event) => {
    const path = event.composedPath();
    const inSidebar = path.some((node) => node instanceof Element && node.localName === 'mux-sidebar');
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      if (node.matches('button, a, input, select, textarea, [role="button"], [contenteditable="true"], mux-ui-button, mux-ui-breadcrumb, mux-ui-tab-strip, mux-pane-picker, mux-mic-button, .dv-tab, .mux-header-btn')) return false;
      if (node.matches('mux-ui-screen-header, mux-title-bar, .sidebar-gutter, .dv-void-container') ||
          (inSidebar && node.matches('.header'))) return true;
    }
    return false;
  };
  document.addEventListener('mousedown', (event) => {
    dragStart = event.button === 0 && isChrome(event) ? { x: event.screenX, y: event.screenY } : null;
  }, true);
  document.addEventListener('mousemove', (event) => {
    if (!dragStart || !(event.buttons & 1)) return;
    if (Math.hypot(event.screenX - dragStart.x, event.screenY - dragStart.y) < 3) return;
    dragStart = null;
    // Wails handles this raw message before the muxterm.desktop: bridge.
    window.webkit.messageHandlers.external.postMessage('wails:drag');
  }, true);
  document.addEventListener('mouseup', () => { dragStart = null; }, true);
  // This window loads muxterm's own origin, so it does not load Wails' web
  // runtime. Tell Wails the page is ready so native ExecJS status events are
  // delivered instead of remaining queued forever.
  window.webkit.messageHandlers.external.postMessage('wails:runtime:ready');
  window.dispatchEvent(new Event('muxterm-browser-ready'));
})();
