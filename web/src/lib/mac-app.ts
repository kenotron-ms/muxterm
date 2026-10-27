declare global {
  interface Window { muxtermDesktopVersion?: string }
}

export function macAppVersion(): string {
  return typeof window.muxtermDesktopVersion === 'string' ? window.muxtermDesktopVersion.trim() : '';
}

export interface MacUpdateStatus {
  phase: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'verifying' | 'restarting' | 'error';
  currentVersion: string;
  latestVersion: string;
  error?: string;
}

function macUpdate(action: 'mac-update-check' | 'mac-update-install', onProgress?: (status: MacUpdateStatus) => void): Promise<MacUpdateStatus> {
  return new Promise((resolve, reject) => {
    const bridge = window.__muxtermDesktopBrowser;
    if (!bridge) {
      reject(new Error('Mac updater is available only inside the Mac app.'));
      return;
    }
    const timeout = window.setTimeout(() => {
      window.removeEventListener('muxterm-mac-update', receive);
      reject(new Error('Mac update did not respond in time.'));
    }, 11 * 60 * 1000);
    const receive = (event: Event) => {
      const status = (event as CustomEvent<MacUpdateStatus>).detail;
      onProgress?.(status);
      if (status.phase !== 'available' && status.phase !== 'up-to-date' && status.phase !== 'restarting' && status.phase !== 'error') return;
      window.clearTimeout(timeout);
      window.removeEventListener('muxterm-mac-update', receive);
      if (status.phase === 'error') reject(new Error(status.error || 'Mac update failed.'));
      else resolve(status);
    };
    window.addEventListener('muxterm-mac-update', receive);
    bridge.send({ type: action });
  });
}

export function checkMacUpdate(onProgress?: (status: MacUpdateStatus) => void): Promise<MacUpdateStatus> {
  return macUpdate('mac-update-check', onProgress);
}

export function installMacUpdate(onProgress?: (status: MacUpdateStatus) => void): Promise<MacUpdateStatus> {
  return macUpdate('mac-update-install', onProgress);
}
