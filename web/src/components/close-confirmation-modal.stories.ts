import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import type { CloseConfirmationRequiredOutcome } from '../types.js';
import './close-confirmation-modal.js';

const paneOutcome: CloseConfirmationRequiredOutcome = {
  type: 'close-outcome',
  cid: 1,
  targetKind: 'pane',
  workspaceId: 'storybook-workspace',
  paneId: 3,
  closeStatus: 'confirmation-required',
  ticket: 'storybook-ticket',
  busyCount: 1,
  unknownCount: 0,
  risks: [{ paneId: 3, title: 'Build server', classification: 'busy', reason: 'foreground-process' }],
  omittedRiskCount: 0,
};

const meta = {
  title: 'Patterns/Destructive close',
  tags: ['autodocs'],
  args: { outcome: paneOutcome, confirming: false },
  render: (args: { outcome: CloseConfirmationRequiredOutcome; confirming: boolean }) => html`
    <close-confirmation-modal .outcome=${args.outcome} ?confirming=${args.confirming}></close-confirmation-modal>`,
} satisfies Meta<{ outcome: CloseConfirmationRequiredOutcome; confirming: boolean }>;

export default meta;
type Story = StoryObj<{ outcome: CloseConfirmationRequiredOutcome; confirming: boolean }>;
export const ActivePane: Story = {};
export const UnknownWorkspace: Story = {
  args: {
    outcome: {
      ...paneOutcome,
      targetKind: 'workspace',
      paneId: undefined,
      busyCount: 0,
      unknownCount: 1,
      risks: [{ paneId: 7, title: 'Remote shell', classification: 'unknown', reason: 'process-inspection-failed' }],
    } as CloseConfirmationRequiredOutcome,
  },
};
export const Confirming: Story = { args: { confirming: true } };
