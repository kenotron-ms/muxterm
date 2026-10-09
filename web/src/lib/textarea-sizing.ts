// Older WebKit lacks field-sizing, so its mirror supplies intrinsic height.
export const nativeTextareaSizing = CSS.supports('field-sizing', 'content');

export function syncTextareaSizing(textarea: HTMLTextAreaElement) {
  const container = textarea.parentElement;
  if (!container?.classList.contains('legacy-textarea-sizing')) return;
  // Templates place the mirror immediately after the textarea in its sizing wrapper.
  const mirror = textarea.nextElementSibling;
  if (mirror?.classList.contains('textarea-mirror')) {
    // Preserve a trailing blank line without adding a wrap to other values.
    const content = textarea.value || textarea.placeholder;
    mirror.textContent = content.endsWith('\n') ? `${content}\u200b` : content;
  }
}
