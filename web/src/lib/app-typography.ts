import './app-typography.css';

export const APP_FONTS = [
  { id: 'system', label: 'System default', family: '' },
  { id: 'serif', label: 'Source Serif 4', family: '"Source Serif 4", Georgia, serif' },
  { id: 'dyslexic', label: 'OpenDyslexic', family: '"OpenDyslexic", system-ui, sans-serif' },
] as const;

export const TEXT_SIZES = [
  { label: 'Smallest', scale: 0.875 },
  { label: 'Small', scale: 0.9375 },
  { label: 'Default', scale: 1 },
  { label: 'Large', scale: 1.125 },
  { label: 'Largest', scale: 1.25 },
] as const;

type AppFont = (typeof APP_FONTS)[number]['id'];
export type AppTypography = { font: AppFont; size: number };
export const DEFAULT_TYPOGRAPHY: AppTypography = { font: 'system', size: 2 };
const storageKey = 'mux-app-typography';

export function readAppTypography(): AppTypography {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    return {
      font: APP_FONTS.find(font => font.id === stored?.font)?.id ?? DEFAULT_TYPOGRAPHY.font,
      size: Number.isInteger(stored?.size) && TEXT_SIZES[stored.size]
        ? stored.size
        : DEFAULT_TYPOGRAPHY.size,
    };
  } catch {
    return DEFAULT_TYPOGRAPHY;
  }
}

export function applyAppTypography(preferences: AppTypography): void {
  const style = document.documentElement.style;
  const family = APP_FONTS.find(font => font.id === preferences.font)?.family;
  if (family) style.setProperty('--app-font-family', family);
  else style.removeProperty('--app-font-family');
  style.setProperty('--app-text-scale', String(TEXT_SIZES[preferences.size].scale));
}

export function saveAppTypography(preferences: AppTypography): void {
  applyAppTypography(preferences);
  try {
    localStorage.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // Keep the live preference when browser storage is unavailable.
  }
}
