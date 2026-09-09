/**
 * applet-scratch.ts -- THROWAWAY. The A1 proof, not a feature.
 *
 * A fourth applet with THREE filters, none of which the old rail had a class
 * for (a tri-state, a text input, and a checkbox). It exists to demonstrate
 * one claim from lib/applet-registry.ts:
 *
 *   adding an applet with three filters is a ZERO-line change to the host.
 *
 * The only edit outside this file is the one-line side-effect import in
 * mux-applets.ts that every built-in already has, plus its id in AppletId.
 * <mux-applets> itself -- its styles, its render, its events -- is untouched.
 *
 * Delete this file, its import, and 'scratch' from AppletId when the proof has
 * been read.
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { FlaskConical } from 'lucide';
import { registerApplet, type AppletElement } from '../../lib/applet-registry.js';
import { appletControlStyles, appletToggle } from '../../lib/applet-controls.js';

const ROWS = [
  { name: 'alpha', kind: 'fruit', ripe: true },
  { name: 'bravo', kind: 'fruit', ripe: false },
  { name: 'charlie', kind: 'veg', ripe: true },
  { name: 'delta', kind: 'veg', ripe: false },
];

@customElement('applet-scratch')
export class AppletScratch extends LitElement implements AppletElement {
  @property({ type: Boolean }) active = false;
  @property({ type: Boolean }) narrow = false;
  @property({ attribute: false }) target: string | null = null;

  /** Filter one: a tri-state the host never had a class for. */
  @state() private _kind: 'any' | 'fruit' | 'veg' = 'any';
  /** Filter two: a text box. The rail had no style for an input at all. */
  @state() private _q = '';
  /** Filter three: a real checkbox, not a styled button. */
  @state() private _ripeOnly = false;

  static override styles = [
    appletControlStyles,
    css`
      :host {
        display: block;
        color: var(--ink-2);
        font-size: var(--t-ui);
      }
      .body {
        height: 100%;
        overflow-y: auto;
        padding: var(--s-6);
      }
      /* A control kind this applet invents for itself. Under the old rail this
         was impossible without editing the host. */
      .q {
        font: inherit;
        font-family: var(--mono);
        font-size: 10.5px;
        color: var(--ink-2);
        background: var(--surface);
        border: 1px solid var(--edge);
        border-radius: var(--r-ctl);
        padding: 3px var(--s-3);
        min-width: 8ch;
        max-width: 16ch;
      }
      .chk {
        display: inline-flex;
        align-items: center;
        gap: var(--s-2);
        font-family: var(--mono);
        font-size: 10.5px;
        color: var(--ink-3);
        cursor: pointer;
      }
      .r {
        display: flex;
        gap: var(--s-3);
        font-family: var(--mono);
        font-size: 12px;
        padding: 3px var(--s-4);
      }
      .r .n {
        color: var(--ink-1);
      }
      .r .k {
        color: var(--ink-3);
      }
      .none {
        color: var(--ink-3);
        padding: var(--s-4) var(--s-1);
      }
    `,
  ];

  override render(): TemplateResult {
    const rows = ROWS.filter(
      (r) =>
        (this._kind === 'any' || r.kind === this._kind) &&
        (this._q === '' || r.name.includes(this._q)) &&
        (!this._ripeOnly || r.ripe),
    );
    return html`
      <div class="body">
        <div class="controls">
          ${appletToggle({
            label: 'any',
            on: this._kind === 'any',
            onToggle: () => (this._kind = 'any'),
          })}
          ${appletToggle({
            label: 'fruit',
            on: this._kind === 'fruit',
            onToggle: () => (this._kind = 'fruit'),
          })}
          ${appletToggle({
            label: 'veg',
            on: this._kind === 'veg',
            onToggle: () => (this._kind = 'veg'),
          })}
          <input
            class="q"
            type="search"
            placeholder="name"
            aria-label="Filter by name"
            .value="${this._q}"
            @input="${(e: Event) => (this._q = (e.target as HTMLInputElement).value)}"
          />
          <label class="chk">
            <input
              type="checkbox"
              .checked="${this._ripeOnly}"
              @change="${(e: Event) => (this._ripeOnly = (e.target as HTMLInputElement).checked)}"
            />ripe only
          </label>
        </div>
        <div class="controls-rule"></div>
        ${rows.length === 0
          ? html`<div class="none">Nothing matches.</div>`
          : rows.map(
              (r) => html`<div class="r"><span class="n">${r.name}</span
                ><span class="k">${r.kind}${r.ripe ? ' · ripe' : ''}</span></div>`,
            )}
        ${nothing}
      </div>
    `;
  }
}

registerApplet({
  id: 'scratch',
  label: 'Scratch',
  icon: FlaskConical,
  element: 'applet-scratch',
  order: 40,
});

declare global {
  interface HTMLElementTagNameMap {
    'applet-scratch': AppletScratch;
  }
}
