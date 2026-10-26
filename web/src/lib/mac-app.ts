declare global {
  interface Window { muxtermDesktopVersion?: string }
}

export function macAppVersion(): string {
  return typeof window.muxtermDesktopVersion === 'string' ? window.muxtermDesktopVersion.trim() : '';
}

export function openMacDownloads(): void {
  window.__muxtermDesktopBrowser?.send({ type: 'mac-release' });
}
