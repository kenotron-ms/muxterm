import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { fixtureJSON, type ApiFixture } from '../stories/api-fixture.js';
import './mux-folder-picker.js';

const fixture: ApiFixture = ({ url, method }) => {
  if (method !== 'GET' || !url.pathname.endsWith('/api/sdk-folders')) return fixtureJSON({}, 404);
  const path = url.searchParams.get('path') || '/home/demo';
  const folders = path === '/home/demo' ? ['atlas', 'notes', 'research'] : path === '/home/demo/atlas' ? ['web', 'docs'] : [];
  return fixtureJSON({ path, base:'/home/demo', parent:path === '/home/demo' ? '/home' : '/home/demo', folders });
};

const meta = {
  title: 'Components/Folder picker',
  tags: ['autodocs'],
  parameters: { apiFixture:fixture },
  render: () => html`<div style="width:320px;padding:24px"><mux-folder-picker inline label="Folder" base="/home/demo" value="/home/demo/atlas"></mux-folder-picker></div>`,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;
export const FolderList: Story = {};
