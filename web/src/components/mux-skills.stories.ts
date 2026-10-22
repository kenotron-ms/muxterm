import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import './mux-skills.js';

const catalog = [
  { id:'acme/skills/project-notes', name:'project-notes', source:'acme/skills', installs:21200 },
  { id:'acme/skills/release-checklist', name:'release-checklist', source:'acme/skills', installs:8400 },
];

function skillsFixture(initial: boolean, loadError: boolean | 'once' = false): ApiFixture {
  let installed = initial ? [{ name:'frontend-design', scope:'user', agents:['Codex'], source:'Local skill', sourceUrl:'' }] : [];
  let loadAttempts = 0;
  return ({ url, method, init }) => {
    if (url.pathname.endsWith('/api/skills/search') && method === 'GET') {
      const query = (url.searchParams.get('q') || '').toLowerCase();
      return fixtureJSON(catalog.filter(skill => `${skill.name} ${skill.source}`.includes(query)));
    }
    if (url.pathname.endsWith('/api/skills') && method === 'GET') {
      const fail = loadError === true || (loadError === 'once' && loadAttempts++ === 0);
      return fail ? fixtureJSON({error:'Skills service unavailable'},503) : fixtureJSON(installed);
    }
    if (url.pathname.endsWith('/api/skills/install') && method === 'POST') {
      const id = JSON.parse(String(init?.body || '{}')).id as string;
      const skill = catalog.find(item => item.id === id);
      if (!skill) return fixtureJSON({ error:'Skill not found' }, 404);
      installed = [...installed, { name:skill.name, scope:'user', agents:['Codex','Claude','Amplifier'], source:skill.source, sourceUrl:'' }];
      return fixtureJSON({ installed:true });
    }
    return fixtureJSON({ error:`No story fixture for ${method} ${url.pathname}` }, 404);
  };
}

const meta = {
  title: 'Screens/Skills',
  tags: ['autodocs'],
  parameters: { layout:'fullscreen', apiFixture:skillsFixture(true) },
  render: () => html`<mux-skills></mux-skills>`,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;
export const Installed: Story = {};
export const PhoneInstalled: Story = { globals:{viewport:{value:'phone390',isRotated:false}} };
export const EmptyLibrary: Story = { parameters: { apiFixture:skillsFixture(false) } };
export const SearchResults: Story = { render:() => html`<mux-skills .query=${'project'}></mux-skills>` };
export const InstalledAfterAction: Story = {
  parameters:{apiFixture:skillsFixture(true)},
  render:() => html`<mux-skills .query=${'project'}></mux-skills>`,
  play:async ({canvasElement}) => {
    const screen = canvasElement.querySelector('mux-skills');
    if (!screen) throw new Error('Skills screen did not mount');
    let installButton = screen.shadowRoot?.querySelector<HTMLElement>('.section:last-of-type .row mux-ui-button');
    for (let attempt=0; !installButton && attempt<60; attempt++) {
      await new Promise(resolve => window.setTimeout(resolve,25));
      installButton = screen.shadowRoot?.querySelector<HTMLElement>('.section:last-of-type .row mux-ui-button');
    }
    if (!installButton) throw new Error('Catalog result did not load');
    installButton.click();
    for (let attempt=0; !screen.shadowRoot?.textContent?.includes('project-notes is installed') && attempt<60; attempt++) {
      await new Promise(resolve => window.setTimeout(resolve,25));
    }
    if (!screen.shadowRoot?.textContent?.includes('project-notes is installed')) throw new Error('Install confirmation did not appear');
  },
};
export const NoSearchResults: Story = { render:() => html`<mux-skills .query=${'unfindable-skill'}></mux-skills>` };
export const LoadError: Story = { parameters:{apiFixture:skillsFixture(false,true)} };
export const RetryRecovers: Story = {
  parameters:{apiFixture:skillsFixture(true,'once')},
  play:async ({canvasElement}) => {
    const screen = canvasElement.querySelector('mux-skills');
    if (!screen) throw new Error('Skills screen did not mount');
    let retry = screen.shadowRoot?.querySelector<HTMLElement>('mux-ui-feedback mux-ui-button');
    for (let attempt=0; !retry && attempt<60; attempt++) {
      await new Promise(resolve => window.setTimeout(resolve,25));
      retry = screen.shadowRoot?.querySelector<HTMLElement>('mux-ui-feedback mux-ui-button');
    }
    if (!retry) throw new Error('Retry action did not appear');
    retry.click();
    for (let attempt=0; !screen.shadowRoot?.textContent?.includes('frontend-design') && attempt<60; attempt++) {
      await new Promise(resolve => window.setTimeout(resolve,25));
    }
    if (!screen.shadowRoot?.textContent?.includes('frontend-design')) throw new Error('Installed skills did not load after retry');
  },
};
export const PhoneSearch: Story = {
  globals:{viewport:{value:'phone390',isRotated:false}},
  render:() => html`<mux-skills .query=${'project'}></mux-skills>`,
};
export const LightPalette: Story = { globals:{palette:'github-light'} };
