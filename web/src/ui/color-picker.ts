import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import './button.js';

export interface ColorChoiceOption { label:string; color:string }

function contrastInk(hex: string): string {
  const value = /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!value) return '#ffffff';
  const channels = [0, 2, 4].map(index => {
    const c = Number.parseInt(value.slice(index, index + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 0.179 ? '#111111' : '#ffffff';
}

/** Preset swatches and a native custom-color field for theme settings. */
@customElement('mux-ui-color-picker')
export class MuxUIColorPicker extends LitElement {
  @property({ attribute:false }) options: ReadonlyArray<ColorChoiceOption> = [];
  @property() value = '';
  @property() fallbackColor = '#000000';
  @property() inputLabel = 'Pick a custom color';
  @property() resetLabel = 'Use theme default';

  static override styles = css`
    :host { display:block; min-width:0; color:var(--ui-text); font:var(--ui-text-sm) var(--ui-font-sans); }
    .swatches { display:flex; flex-wrap:wrap; gap:var(--ui-space-2); margin-bottom:var(--ui-space-5); }
    .swatch { box-sizing:border-box; display:grid; place-items:center; width:var(--ui-control-lg); height:var(--ui-control-lg); padding:0; border:0; border-radius:var(--ui-radius-pill); background:transparent; cursor:pointer; }
    .swatch:focus-visible { outline:2px solid var(--ui-focus); outline-offset:1px; }
    .dot { box-sizing:border-box; display:grid; place-items:center; width:var(--ui-space-9); height:var(--ui-space-9); border:1px solid var(--ui-border); border-radius:var(--ui-radius-pill); background:var(--swatch-color); color:var(--swatch-ink); font-weight:700; transition:transform var(--ui-motion-fast) ease; }
    .swatch:hover .dot { transform:scale(1.08); }
    .swatch[aria-pressed='true'] .dot { box-shadow:0 0 0 var(--ui-space-1) var(--ui-surface-base),0 0 0 var(--ui-space-2) var(--ui-accent); }
    .custom-row { display:flex; align-items:center; gap:var(--ui-space-4); min-width:0; }
    .custom { display:flex; align-items:center; gap:var(--ui-space-3); min-height:var(--ui-control-lg); cursor:pointer; }
    input { box-sizing:border-box; width:var(--ui-space-9); height:var(--ui-space-9); flex:none; padding:0; border:1px solid var(--ui-border); border-radius:var(--ui-radius-pill); background:none; cursor:pointer; appearance:none; }
    input::-webkit-color-swatch-wrapper { padding:0; }
    input::-webkit-color-swatch { border:0; border-radius:var(--ui-radius-pill); }
    input:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    .custom.selected input { outline:2px solid var(--ui-accent); outline-offset:2px; }
    .custom-label { color:var(--ui-text-muted); }
    .custom.selected .custom-label { color:var(--ui-text); font-weight:650; }
    mux-ui-button { margin-left:auto; }
    @media(max-width:350px) { .custom-row { flex-wrap:wrap; } mux-ui-button { margin-left:0; } }
    @media(prefers-reduced-motion:reduce) { .dot { transition:none; } }
  `;

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles:true, composed:true }));
  }

  private pick(color: string): void { this.value = color; this.emit('color-change', { color }); }

  private reset(): void { this.value = ''; this.emit('color-reset'); }

  private onInput(event: Event): void {
    event.stopPropagation();
    this.pick((event.target as HTMLInputElement).value);
  }

  override render() {
    const current = this.value.toLowerCase();
    const customSelected = Boolean(current) && !this.options.some(option => option.color.toLowerCase() === current);
    return html`<div class="swatches" role="group" aria-label="Preset colors">${this.options.map(option => {
      const selected = current === option.color.toLowerCase();
      return html`<button class="swatch" type="button" title=${option.label} aria-label=${option.label} aria-pressed=${String(selected)} @click=${() => this.pick(option.color)}><span class="dot" style=${styleMap({'--swatch-color':option.color,'--swatch-ink':contrastInk(option.color)})} aria-hidden="true">${selected ? '✓' : ''}</span></button>`;
    })}</div><div class="custom-row"><label class="custom ${customSelected ? 'selected' : ''}"><input type="color" aria-label=${this.inputLabel} .value=${current || this.fallbackColor} @input=${this.onInput}><span class="custom-label">Custom…</span></label><mux-ui-button size="small" variant="secondary" @click=${this.reset}>${this.resetLabel}</mux-ui-button></div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-color-picker': MuxUIColorPicker } }
