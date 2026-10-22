import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import { MuxStore } from '../state.js';
import { SessiondType, type SessiondPaneInfo } from '../types.js';
import './mux-pane-picker.js';

const pane = (paneId: number, title: string): SessiondPaneInfo => ({ paneId, title, cols:80, rows:24 });

function paneFixture(panes: SessiondPaneInfo[], activePaneId: number, attention: number[] = [], workspaceName = 'Atlas'): MuxStore {
  const fixture = new MuxStore();
  fixture.applySessiond({
    type:SessiondType.WorkspaceList,
    workspaces:[{ workspaceId:'story-workspace', name:workspaceName, paneCount:panes.length }],
  });
  fixture.applySessiond({ type:SessiondType.Composition, workspaceId:'story-workspace', panes, layout:'' });
  fixture.setActivePane(activePaneId);
  for (const paneId of attention) fixture.ringPane(paneId);
  return fixture;
}

const single = () => paneFixture([pane(1,'Terminal')], 0);
const many = () => paneFixture([
  pane(1,'Editor'), pane(2,'Build logs'), pane(3,'Test runner'), pane(4,'Server'),
  pane(5,'Git status'), pane(6,'Docs'), pane(7,'Shell'), pane(8,'Database'), pane(9,'Notes'),
], 7);
const attention = () => paneFixture([pane(1,'Editor'),pane(2,'Build logs'),pane(3,'Server')], 2, [2,3]);
const longNames = () => paneFixture([
  pane(1,'Deployment status for the research environment'),
  pane(2,'Investigating a long-running application trace'),
], 2, [], 'Research and development workspace with a long name');

function view(fixture: MuxStore) {
  return html`<div style="box-sizing:border-box;display:flex;align-items:center;gap:var(--ui-space-4);width:100%;height:var(--ui-control-lg);padding:0 var(--ui-space-5);border-bottom:1px solid var(--ui-border);background:var(--ui-surface-raised)">
    <strong style="color:var(--ui-text);font:600 var(--ui-text-md) var(--ui-font-sans)">muxterm</strong>
    <mux-pane-picker .paneStore=${fixture}
      @pane-select=${(event: CustomEvent<{paneId:number}>) => fixture.setActivePane(event.detail.paneId)}
      @pane-create-request=${() => {
        const paneId = Math.max(0, ...fixture.panes.map(row => row.paneId)) + 1;
        fixture.applySessiond({ type:SessiondType.PaneAdded, paneId, cols:80, rows:24, title:`Pane ${paneId}` });
        fixture.setActivePane(paneId);
      }}
      @pane-close=${(event: CustomEvent<{paneId:number}>) => fixture.applySessiond({ type:SessiondType.PaneClosed, paneId:event.detail.paneId })}
    ></mux-pane-picker>
  </div>`;
}

const meta = {
  title:'Composites/Mobile pane picker',
  tags:['autodocs'],
  parameters:{ layout:'fullscreen' },
  globals:{ viewport:{ value:'phone390', isRotated:false } },
  render:() => view(single()),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;
const openSheet: NonNullable<Story['play']> = async ({ canvasElement }) => {
  canvasElement.querySelector('mux-pane-picker')?.shadowRoot?.querySelector<HTMLButtonElement>('.breadcrumb')?.click();
};

export const Single: Story = { play:openSheet };
export const ManyPanes: Story = { render:() => view(many()), play:openSheet };
export const NeedsAttention: Story = { render:() => view(attention()), play:openSheet };
export const LongNames: Story = { render:() => view(longNames()), play:openSheet };
