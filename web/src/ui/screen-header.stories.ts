import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { Folder, NotebookTabs, PanelRight } from 'lucide';
import { icon } from '../lib/icons.js';
import './screen-header.js';
import './button.js';
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
export const WithWorkspace: Story = { render:() => html`<div style="margin:-32px"><mux-ui-screen-header section="Atlas" heading="New chat" label="New chat" with-section-icon><span slot="section-icon">${icon(Folder,{size:14})}</span></mux-ui-screen-header><div style="padding:var(--ui-space-8);font-size:var(--ui-text-2xl)">What would you like to do?</div></div>` };
export const LongLabels: Story = { args:{section:'A workspace with a long descriptive name',heading:'A scheduled task with a long descriptive name'}, render:(args:HeaderArgs) => html`<div style="width:min(360px,100%);margin:-32px 0"><mux-ui-screen-header .section=${args.section} .heading=${args.heading}></mux-ui-screen-header><mux-ui-page-intro heading="Scheduled jobs" description="Repeatable work in persistent conversations"></mux-ui-page-intro></div>` };
export const Light: Story = { globals:{palette:'github-light'} };
export const PhoneHidesDuplicateStrip: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const ActionToolbar: Story = { render:() => html`<div style="margin:-32px"><mux-ui-screen-header section="Component library" heading="Design review" label="Design review" with-section-icon with-actions show-on-phone><span slot="section-icon">${icon(Folder,{size:14})}</span><h1 slot="heading" style="margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 var(--ui-text-xl) var(--ui-font-sans)">Design review</h1><div slot="actions" style="display:flex;align-items:center;gap:var(--ui-space-4)"><mux-ui-button icon-only variant="quiet" size="small" accessible-label="Open goal ledger">${icon(NotebookTabs,{size:16})}</mux-ui-button><mux-ui-button icon-only variant="quiet" size="small" accessible-label="Open utility pane">${icon(PanelRight,{size:17})}</mux-ui-button></div></mux-ui-screen-header></div>` };
export const PhoneActionToolbar: Story = { globals:{viewport:{value:'phone390',isRotated:false}},render:ActionToolbar.render };
export const LightActionToolbar: Story = { globals:{palette:'github-light'},render:ActionToolbar.render };
export const LongActionToolbar: Story = { render:() => html`<div style="width:min(520px,100%);margin:-32px 0"><mux-ui-screen-header section="A workspace with a long descriptive name" heading="A conversation with a long descriptive title" with-actions><div slot="actions" style="display:flex;align-items:center;gap:var(--ui-space-4)"><mux-ui-button icon-only variant="quiet" size="small" accessible-label="Open goal ledger">${icon(NotebookTabs,{size:16})}</mux-ui-button><mux-ui-button icon-only variant="quiet" size="small" accessible-label="Open utility pane">${icon(PanelRight,{size:17})}</mux-ui-button></div></mux-ui-screen-header></div>` };
