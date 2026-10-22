import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import './mux-browser-assistant.js';

type Connection = { id: string; name: string; lastSeen: string; control?: { origin: string; managed: boolean } };

function fixture(initial: Connection[] = [], fail = false): ApiFixture {
  let items = [...initial];
  return ({ url, method }) => {
    if (url.pathname.endsWith('/api/browser-assistant/connections') && method === 'GET') {
      return fail ? fixtureJSON({ error:'Browser service unavailable' }, 503) : fixtureJSON({ items });
    }
    if (url.pathname.endsWith('/api/browser-assistant/pairings') && method === 'POST') {
      return fixtureJSON({ code:'STORY-1234', expiresAt:'2030-01-01T12:00:00Z' });
    }
    if (url.pathname.endsWith('/commands') && method === 'POST') {
      return fixtureJSON({ id:'request-story', status:'complete', result:{ title:'Example tab' } });
    }
    if (url.pathname.endsWith('/control') && method === 'DELETE') {
      items = items.map(item => ({ ...item, control:undefined }));
      return fixtureJSON({ ok:true });
    }
    if (url.pathname.includes('/api/browser-assistant/connections/') && method === 'DELETE') {
      items = items.filter(item => item.id !== url.pathname.split('/').at(-1));
      return fixtureJSON({ ok:true });
    }
    return fixtureJSON({ error:`No browser-assistant fixture for ${method} ${url.pathname}` }, 501);
  };
}

const paired: Connection = {
  id:'browser-story', name:'Chrome on laptop', lastSeen:'2026-10-22T01:00:00Z',
  control:{ origin:'https://example.test', managed:false },
};

const meta = {
  title:'Screens/Browser assistant',
  tags:['autodocs'],
  parameters:{ layout:'fullscreen' },
  render:() => html`<div style="max-width:760px;margin:auto;padding:24px"><mux-browser-assistant></mux-browser-assistant></div>`,
} satisfies Meta;

export default meta;
type Story = StoryObj;
export const Unpaired: Story = { parameters:{ apiFixture:fixture() } };
export const Paired: Story = { parameters:{ apiFixture:fixture([paired]) } };
export const Unavailable: Story = { parameters:{ apiFixture:fixture([],true) } };
