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
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement && node.href);
    if (!anchor) return;
    const url = new URL(anchor.href, location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === location.origin) return;
    event.preventDefault();
    window.__muxtermDesktopBrowser.send({
      type: 'open-link', url: url.href,
      destination: localStorage.getItem('muxterm.mac.linkDestination') === 'default' ? 'default' : 'muxterm',
    });
  }, true);
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
