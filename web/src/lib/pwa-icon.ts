import { apiPath } from './base-path.js';

export const APP_ICON_CHARMS = [
  { id: 'hourglass', label: 'Hourglass' },
  { id: 'key', label: 'Key' },
  { id: 'lantern', label: 'Lantern' },
  { id: 'rocket', label: 'Rocket' },
] as const;

export const APP_ICON_COLORS = [
  { id: 'coral', label: 'Coral', hex: '#A94747' },
  { id: 'indigo', label: 'Indigo', hex: '#344C91' },
  { id: 'ochre', label: 'Ochre', hex: '#85591E' },
  { id: 'plum', label: 'Plum', hex: '#6B4B83' },
  { id: 'teal', label: 'Teal', hex: '#176D75' },
] as const;

export type AppIconChoice = {
  charm: typeof APP_ICON_CHARMS[number]['id'];
  color: typeof APP_ICON_COLORS[number]['id'];
};

export function appIconVersion(choice: AppIconChoice): string {
  return `${choice.charm}-${choice.color}`;
}

export function appIconImage(choice: AppIconChoice, filename: string): string {
  return apiPath(`/pwa/variants/${choice.charm}/${choice.color}/${filename}`);
}

/** Refresh the page's identity hints when another browser saves a choice. */
export function applyPWAIconLinks(choice: AppIconChoice): void {
  const version = appIconVersion(choice);
  const links: Array<[string, string]> = [
    ['link[rel="manifest"]', `manifest.webmanifest?v=${version}`],
    ['link[rel="icon"][type="image/svg+xml"]', `favicon.svg?v=${version}`],
    ['link[rel="icon"][type="image/png"]', `favicon-32.png?v=${version}`],
    ['link[rel="apple-touch-icon"]', `apple-touch-icon.png?v=${version}`],
  ];
  for (const [selector, href] of links) {
    document.querySelector<HTMLLinkElement>(selector)?.setAttribute('href', apiPath(`/${href}`));
  }
}
