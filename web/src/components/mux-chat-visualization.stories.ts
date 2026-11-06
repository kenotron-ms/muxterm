import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import './mux-chat-visualization.js';

const root = '/home/demo/project';
const path = `${root}/storyboard/connections.html`;
const document = `<!doctype html><html><head><style>body{font:16px system-ui;background:#f7f2dd;color:#203040;padding:24px}button{padding:10px 16px}</style></head><body><h1>Project connections</h1><p id="status">Ready</p><button onclick="document.getElementById('status').textContent='Clicked'">Interact</button></body></html>`;

const fixture: ApiFixture = ({ url, method }) => method === 'GET' && url.pathname === '/api/sdk-chats/storybook-visualization/utility/raw' && url.searchParams.get('path') === 'storyboard/connections.html'
  ? new Response(document, { headers: { 'Content-Type': 'application/octet-stream' } })
  : fixtureJSON({ error: 'File unavailable' }, 404);

interface Args { mode: string }
const meta = {
  title: 'Chat/Inline visualization',
  tags: ['autodocs'],
  parameters: { apiFixture: fixture },
  args: { mode: 'wide' },
  render: (args: Args) => html`<div style="width:min(100%,760px);margin:auto"><mux-chat-visualization .path=${path} .projectPath=${root} .sessionId=${'storybook-visualization'} .mode=${args.mode}></mux-chat-visualization></div>`,
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const Wide: Story = {};
export const Phone: Story = { globals: { viewport: { value: 'phone390', isRotated: false } } };
