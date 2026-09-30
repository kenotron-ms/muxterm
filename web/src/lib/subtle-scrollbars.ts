import { css } from 'lit';

// Shadow roots need their own scrollbar rules. Keep tracks invisible and use
// the same quiet thumb in chat, navigation, and settings surfaces.
export const subtleScrollbars = css`
  *, *::before, *::after {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--chrome-text-dim, #9aa3b8) 34%, transparent) transparent;
  }
  *::-webkit-scrollbar { width: 6px; height: 6px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--chrome-text-dim, #9aa3b8) 34%, transparent);
    border-radius: 999px;
  }
  *::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--chrome-text-dim, #9aa3b8) 58%, transparent);
  }
`;
