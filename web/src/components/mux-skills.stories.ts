import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import './mux-skills.js';

const catalog = [
  { id:'acme/skills/project-notes', name:'project-notes', source:'acme/skills', installs:21200 },
  { id:'acme/skills/release-checklist', name:'release-checklist', source:'acme/skills', installs:8400 },
];

function skillsFixture(initial: boolean): ApiFixture {
  let installed = initial ? [{ name:'frontend-design', scope:'user', agents:['Codex'], source:'Local skill', sourceUrl:'' }] : [];
  return ({ url, method, init }) => {
    if (url.pathname.endsWith('/api/skills/search') && method === 'GET') {
      const query = (url.searchParams.get('q') || '').toLowerCase();
      return fixtureJSON(catalog.filter(skill => `${skill.name} ${skill.source}`.includes(query)));
    }
    if (url.pathname.endsWith('/api/skills') && method === 'GET') return fixtureJSON(installed);
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
export const EmptyLibrary: Story = { parameters: { apiFixture:skillsFixture(false) } };
