import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

export interface ThemePreview {
  background: string;
  foreground: string;
  blue: string;
  green: string;
  cursor: string;
  backgroundImage?: string;
}

/** A selectable preview of a theme's terminal colors and optional backdrop. */
@customElement('mux-ui-theme-choice')
export class MuxUIThemeChoice extends LitElement {
  @property() label = '';
  @property({ attribute:false }) preview: ThemePreview = {background:'var(--ui-surface-base)',foreground:'var(--ui-text)',blue:'var(--ui-accent)',green:'var(--ui-success)',cursor:'var(--ui-text)'};
  @property({ type:Boolean, reflect:true }) selected = false;
  @property({ type:Boolean, reflect:true }) disabled = false;

  static override styles = css`
    :host { display:block; min-width:0; font-family:var(--ui-font-sans); }
    button { box-sizing:border-box; position:relative; display:block; width:100%; padding:0; overflow:hidden; border:2px solid transparent; border-radius:var(--ui-radius-md); background:transparent; color:var(--ui-text); font:inherit; text-align:left; cursor:pointer; transition:border-color var(--ui-motion-fast) ease,transform var(--ui-motion-fast) ease; }
    button:hover:not(:disabled) { transform:translateY(-1px); }
    button:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    button:disabled { opacity:.5; cursor:default; }
    :host([selected]) button { border-color:var(--ui-accent); }
    .preview { box-sizing:border-box; min-height:var(--ui-control-lg); padding:var(--ui-space-4) var(--ui-space-4) var(--ui-space-3); background:var(--preview-background); background-image:var(--preview-backdrop,none); background-size:cover; color:var(--preview-foreground); font:var(--ui-text-xs)/1.6 var(--ui-font-mono); }
    .topbar { display:flex; gap:var(--ui-space-2); margin-bottom:var(--ui-space-3); }
    .dot { width:var(--ui-space-3); height:var(--ui-space-3); border-radius:50%; }
    .dot.red { background:var(--ui-danger); } .dot.yellow { background:var(--ui-warning); } .dot.green { background:var(--ui-success); }
    .line { margin-bottom:var(--ui-space-1); }
    .blue { color:color-mix(in srgb,var(--preview-blue) 50%,var(--preview-foreground)); }
    .green { color:color-mix(in srgb,var(--preview-green) 50%,var(--preview-foreground)); }
    .cursor { display:inline-block; width:var(--ui-space-3); height:var(--ui-space-5); margin-top:var(--ui-space-1); vertical-align:text-bottom; background:var(--preview-cursor); }
    .label { padding:var(--ui-space-3); background:var(--ui-surface-raised); color:var(--ui-text-muted); font-size:var(--ui-text-xs); text-align:center; }
    :host([selected]) .label { color:var(--ui-text); font-weight:650; }
    .check { position:absolute; top:var(--ui-space-2); right:var(--ui-space-3); color:var(--ui-accent); font-size:var(--ui-text-xs); font-weight:700; }
    @media(max-width:700px) { .label { font-size:var(--ui-text-sm); } }
    @media(prefers-reduced-motion:reduce) { button { transition:none; } }
  `;

  override focus(options?: FocusOptions): void { this.renderRoot.querySelector('button')?.focus(options); }
  override click(): void { if (!this.disabled) this.renderRoot.querySelector('button')?.click(); }

  override render() {
    const palette = this.preview;
    const previewStyle = styleMap({
      '--preview-background':palette.background,
      '--preview-foreground':palette.foreground,
      '--preview-blue':palette.blue,
      '--preview-green':palette.green,
      '--preview-cursor':palette.cursor,
      '--preview-backdrop':palette.backgroundImage || undefined,
    });
    return html`<button type="button" title=${this.label} aria-label=${this.label || nothing} aria-pressed=${String(this.selected)} ?disabled=${this.disabled}>
      <div class="preview" style=${previewStyle} aria-hidden="true"><div class="topbar"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span></div><div class="line"><span class="blue">~/proj</span><span class="green"> main</span></div><div class="line"><span class="blue">src/ </span><span class="green">run.sh</span></div><div class="line">$ ls</div><span class="cursor"></span></div>
      <div class="label">${this.label}</div>${this.selected ? html`<span class="check" aria-hidden="true">✓</span>` : nothing}
    </button>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-theme-choice': MuxUIThemeChoice } }
