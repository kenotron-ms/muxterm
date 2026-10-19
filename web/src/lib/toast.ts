export type ToastTone = 'error' | 'info';

export function showToast(message: string, tone: ToastTone = 'error'): void {
  window.dispatchEvent(new CustomEvent('muxterm-toast', { detail: { message, tone } }));
}
