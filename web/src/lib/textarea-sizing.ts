// Older WebKit lacks field-sizing, so its mirror supplies intrinsic height.
export const nativeTextareaSizing = CSS.supports('field-sizing', 'content');

export function syncTextareaSizing(textarea: HTMLTextAreaElement) {
  const container = textarea.parentElement;
  if (!container?.classList.contains('legacy-textarea-sizing')) return;
  const mirror = textarea.nextElementSibling;
  if (mirror?.classList.contains('textarea-mirror')) {
    // Preserve the line created by a trailing newline.
    mirror.textContent = `${textarea.value || textarea.placeholder}\u200b`;
  }
}
