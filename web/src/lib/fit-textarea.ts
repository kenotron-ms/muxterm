export const TEXTAREA_RESIZE_DELAY_MS = 200;

export function fitTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}
