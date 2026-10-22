import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './page-intro.js';
import './button.js';

interface PageIntroArgs { eyebrow: string; heading: string; description: string }
const meta = {
  title: 'Patterns/Page intro',
  tags: ['autodocs'],
  args: { eyebrow:'', heading:'Skills', description:'Find and install shared skills for your chats.' },
  render: (args: PageIntroArgs) => html`<div style="margin:-32px"><mux-ui-page-intro .eyebrow=${args.eyebrow} .heading=${args.heading} .description=${args.description}></mux-ui-page-intro></div>`,
} satisfies Meta<PageIntroArgs>;

export default meta;
type Story = StoryObj<PageIntroArgs>;
export const Standard: Story = {};
export const WithAction: Story = {
  render: () => html`<div style="margin:-32px"><mux-ui-page-intro eyebrow="Automation" heading="Scheduled jobs" description="Repeatable work in persistent conversations"><mux-ui-button slot="action" variant="primary">New job</mux-ui-button></mux-ui-page-intro></div>`,
};
