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
  window.dispatchEvent(new Event('muxterm-browser-ready'));
})();
