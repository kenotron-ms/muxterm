import { css } from 'lit';

/** Shared phone presentation for detailed choice menus. Desktop placement stays
 * with the screen so a trigger can open above or below its composer. */
export const choicePickerSheetStyles = css`
  @media(max-width:700px) {
    details.choice-picker-sheet[open] { z-index:70; }
    details.choice-picker-sheet .panel {
      position:fixed; z-index:70; inset:auto 0 0; width:100vw; max-width:none;
      max-height:min(78dvh,var(--ui-dialog-height)); padding:var(--ui-space-6);
      border-radius:var(--ui-radius-xl) var(--ui-radius-xl) 0 0;
      border-bottom:0; box-shadow:var(--ui-shadow-sheet);
    }
    details.choice-picker-sheet .panel::before {
      content:''; display:block; width:var(--ui-control-md); height:var(--ui-space-2);
      margin:0 auto var(--ui-space-5); border-radius:var(--ui-radius-pill);
      background:var(--ui-border);
    }
  }
`;

export function closeChoicePickerOnEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const picker = event.currentTarget as HTMLDetailsElement;
  if (!picker.open) return;
  event.preventDefault();
  event.stopPropagation();
  picker.open = false;
  picker.querySelector('summary')?.focus();
}
