export type LinkDestination = 'muxterm' | 'default';

const KEY = 'muxterm.mac.linkDestination';

export function linkDestination(): LinkDestination {
  try { return localStorage.getItem(KEY) === 'default' ? 'default' : 'muxterm'; }
  catch { return 'muxterm'; }
}

export function saveLinkDestination(value: LinkDestination): void {
  try { localStorage.setItem(KEY, value); } catch { /* storage unavailable */ }
}

export function openLink(url: string): void {
  const bridge = window.__muxtermDesktopBrowser;
  if (bridge) bridge.send({ type: 'open-link', url, destination: linkDestination() });
  else window.open(url, '_blank', 'noopener');
}
