import { LitElement, css, html, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import '../ui/button.js';
import '../ui/feedback.js';

/** A model-supplied remote image stays inert until its reader asks to load it. */
@customElement('mux-chat-remote-image')
export class MuxChatRemoteImage extends LitElement {
  @property() src = '';
  @property() alt = '';
  @state() private requested = false;
  @state() private failed = false;

  static styles = css`
    :host { display:block; max-width:100%; margin:var(--ui-space-4) 0; color:var(--ui-text); }
    mux-ui-button { max-width:100%; }
    mux-ui-button::part(button) { height:auto; padding-block:var(--ui-space-4); text-align:left; white-space:normal; }
    a { display:inline-block; max-width:100%; color:var(--ui-accent); }
    a:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    img { box-sizing:border-box; display:block; max-width:100%; max-height:var(--ui-media-preview-max-height); width:auto; height:auto; object-fit:contain; border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); }
  `;

  protected override willUpdate(changed: PropertyValues<this>): void {
    // A streaming Markdown token can change its URL while keeping this DOM
    // node. Each distinct URL needs its own explicit load click.
    if (changed.has('src') && changed.get('src') !== this.src) {
      this.requested = false;
      this.failed = false;
    }
  }

  override render() {
    let url: URL;
    try { url = new URL(this.src); }
    catch { return html`${this.alt}`; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return html`${this.alt}`;
    const label = this.alt || 'Image';
    if (!this.requested) {
      return html`<mux-ui-button variant="secondary" size="small" @click=${() => { this.requested = true; }}>Load ${label} from ${url.host}</mux-ui-button>`;
    }
    if (this.failed) {
      return html`<mux-ui-feedback kind="error" appearance="panel">Image could not load. <a href=${this.src} target="_blank" rel="noopener noreferrer nofollow">Open image</a></mux-ui-feedback>`;
    }
    return html`<a href=${this.src} target="_blank" rel="noopener noreferrer nofollow"><img src=${this.src} alt=${label} loading="lazy" referrerpolicy="no-referrer" @error=${() => { this.failed = true; }}></a>`;
  }
}
