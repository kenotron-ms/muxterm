import type * as Monaco from 'monaco-editor';

/** Monaco has one theme per window, so source and diff viewers share this palette. */
export function applyMuxMonacoTheme(monaco: typeof Monaco, element: HTMLElement): string {
  const style = getComputedStyle(element);
  const background = style.getPropertyValue('--ui-surface-base').trim() || '#1a1b26';
  const foreground = style.getPropertyValue('--ui-text').trim() || '#c0caf5';
  const light = style.colorScheme === 'light' || style.colorScheme.startsWith('light ');
  monaco.editor.defineTheme('muxterm-chat-editor', {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': background,
      'editor.foreground': foreground,
    },
  });
  monaco.editor.setTheme('muxterm-chat-editor');
  return `${light}\u0000${background}\u0000${foreground}`;
}

export function muxMonacoThemeKey(element: HTMLElement): string {
  const style = getComputedStyle(element);
  return `${style.colorScheme.startsWith('light')}\u0000${style.getPropertyValue('--ui-surface-base').trim()}\u0000${style.getPropertyValue('--ui-text').trim()}`;
}
