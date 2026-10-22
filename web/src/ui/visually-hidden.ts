import { css } from 'lit';

/** Keep text available to assistive technology without affecting layout. */
export const visuallyHidden = css`
  position: absolute;
  width: var(--ui-space-px);
  height: var(--ui-space-px);
  padding: 0;
  margin: calc(-1 * var(--ui-space-px));
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
`;
