import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './screen-header.js';
import './page-intro.js';

interface HeaderArgs { section: string; heading: string }
const meta = {
  title:'Patterns/Screen header',
  tags:['autodocs'],
  args:{section:'Tools',heading:'Skills'},
  render:(args:HeaderArgs) => html`<div style="margin:-32px"><mux-ui-screen-header .section=${args.section} .heading=${args.heading}></mux-ui-screen-header><mux-ui-page-intro .heading=${args.heading} description="Find and install shared skills for your chats."></mux-ui-page-intro></div>`,
} satisfies Meta<HeaderArgs>;

export default meta;
type Story = StoryObj<HeaderArgs>;
export const Standard: Story = {};
export const LongLabels: Story = { args:{section:'A workspace with a long descriptive name',heading:'A scheduled task with a long descriptive name'}, render:(args:HeaderArgs) => html`<div style="width:min(360px,100%);margin:-32px 0"><mux-ui-screen-header .section=${args.section} .heading=${args.heading}></mux-ui-screen-header><mux-ui-page-intro heading="Scheduled jobs" description="Repeatable work in persistent conversations"></mux-ui-page-intro></div>` };
export const Light: Story = { globals:{palette:'github-light'} };
export const PhoneHidesDuplicateStrip: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
