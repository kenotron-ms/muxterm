declare global {
  interface Window { muxtermDesktopVersion?: string }
}

import type { AutomaticUpdateStatus } from './update.js';

function macAutomatic(action: 'mac-auto-status' | 'mac-auto-set', enabled?: boolean): Promise<AutomaticUpdateStatus> {
  return new Promise((resolve, reject) => {
    const bridge = window.__muxtermDesktopBrowser;
    if (!bridge) { reject(new Error('Automatic Mac updates require the Mac app.')); return; }
    const timer = window.setTimeout(() => { window.removeEventListener('muxterm-mac-auto-update', receive); reject(new Error('Mac update setting did not respond.')); }, 5000);
    const receive = (event: Event) => {
      window.clearTimeout(timer);
      window.removeEventListener('muxterm-mac-auto-update', receive);
      const status = (event as CustomEvent<AutomaticUpdateStatus & {error?: string}>).detail;
      if (status.error) reject(new Error(status.error)); else resolve(status);
    };
    window.addEventListener('muxterm-mac-auto-update', receive);
    bridge.send(action === 'mac-auto-set' ? { type: action, enabled } : { type: action });
  });
}

export function fetchMacAutomaticUpdateStatus(): Promise<AutomaticUpdateStatus> { return macAutomatic('mac-auto-status'); }
export function setMacAutomaticUpdates(enabled: boolean): Promise<AutomaticUpdateStatus> { return macAutomatic('mac-auto-set', enabled); }

export function macAppVersion(): string {
  return typeof window.muxtermDesktopVersion === 'string' ? window.muxtermDesktopVersion.trim() : '';
}

export interface MacUpdateStatus {
  phase: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'verifying' | 'restarting' | 'deferred' | 'error';
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
      if (status.phase !== 'available' && status.phase !== 'up-to-date' && status.phase !== 'restarting' && status.phase !== 'deferred' && status.phase !== 'error') return;
      window.clearTimeout(timeout);
      window.removeEventListener('muxterm-mac-update', receive);
      if (status.phase === 'error' || status.phase === 'deferred') reject(new Error(status.error || 'Mac update could not proceed.'));
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
