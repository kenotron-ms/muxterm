import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { html } from 'lit';
import './dialog.js';
import './button.js';

interface DialogArgs {
  size: 'standard' | 'compact' | 'wide';
  presentation: 'centered' | 'adaptive';
  label: string;
  description: string;
  dismissable: boolean;
}

const meta = {
  title: 'Components/Dialog',
  tags: ['autodocs'],
  args: { size: 'standard', presentation:'centered', label: 'Example settings',description:'Change application preferences.',dismissable:true },
  argTypes: { size: { control: 'select', options: ['standard', 'compact', 'wide'] }, presentation:{control:'select',options:['centered','adaptive']} },
  render: (args: DialogArgs) => html`
    <mux-ui-dialog open .size=${args.size} .presentation=${args.presentation} .label=${args.label} .description=${args.description} .dismissable=${args.dismissable}>
      <section style=${`display:flex;flex-direction:column;min-height:0;${args.size !== 'compact' ? 'flex:1' : ''}`}>
        <header style="padding:var(--ui-space-6);border-bottom:1px solid var(--ui-border)">
          <h2 style="margin:0;font-size:var(--ui-text-xl)">${args.label}</h2>
        </header>
        <div style=${`overflow:auto;padding:var(--ui-space-6);color:var(--ui-text-muted);${args.size !== 'compact' ? 'flex:1' : ''}`}>
          A feature owns the content. The dialog owns the modal surface, focus containment,
          backdrop dismissal, and Escape behavior.
        </div>
        <footer style="display:flex;justify-content:flex-end;gap:var(--ui-space-4);padding:var(--ui-space-6);border-top:1px solid var(--ui-border)">
          <mux-ui-button @click=${(event: Event) => (event.currentTarget as HTMLElement).closest('mux-ui-dialog')?.removeAttribute('open')}>Done</mux-ui-button>
        </footer>
      </section>
    </mux-ui-dialog>
  `,
} satisfies Meta<DialogArgs>;

export default meta;
type Story = StoryObj<DialogArgs>;
export const Standard: Story = {};
export const Wide: Story = { args: { size: 'wide', label: 'Settings' } };
export const Compact: Story = { args: { size: 'compact', label: 'Project details' } };
export const PhoneSheet: Story = { args:{size:'compact',presentation:'adaptive',label:'Edit project'},globals:{viewport:{value:'phone390',isRotated:false}} };
export const BusyLocked: Story = { args:{size:'compact',label:'Creating workspace',dismissable:false} };
