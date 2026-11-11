import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './mux-markdown-document.js';

interface Args { name: string; source: string }

const source = ['# Project guide', ...Array.from({ length: 120 }, (_, index) =>
  `## Section ${index + 1}\n\nA paragraph with **emphasis**, a [link](https://example.com), and a little more detail.`)].join('\n\n');

const meta = {
  title: 'Components/Markdown Document',
  args: { name:'guide.md', source },
  render: (args: Args) => html`<div class="viewer-body" style="height:100vh;overflow:auto;background:#171821;color:#c0caf5">
    <mux-markdown-document .name=${args.name} .source=${args.source}></mux-markdown-document>
  </div>`,
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<Args>;

export const Document: Story = {};
