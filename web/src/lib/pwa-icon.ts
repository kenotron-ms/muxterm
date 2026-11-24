import { apiPath } from './base-path.js';

const artworkRevision = 2;

export function appIconImage(backdrop: string, filename: string): string {
  return apiPath(`/pwa/backdrops/${encodeURIComponent(backdrop)}/${filename}?art=${artworkRevision}`);
}

/** Refresh the page's identity hints when the server backdrop changes. */
export function applyPWAIconLinks(backdrop: string): void {
  const version = encodeURIComponent(`${backdrop}.${artworkRevision}`);
  const links: Array<[string, string]> = [
    ['link[rel="manifest"]', `manifest.webmanifest?v=${version}`],
    ['link[rel="icon"][type="image/png"]', `favicon-32.png?v=${version}`],
    ['link[rel="apple-touch-icon"]', `apple-touch-icon.png?v=${version}`],
  ];
  for (const [selector, href] of links) {
    document.querySelector<HTMLLinkElement>(selector)?.setAttribute('href', apiPath(`/${href}`));
  }
}
