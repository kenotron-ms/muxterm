import { LitElement, css, html, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/** A model-supplied remote image stays inert until its reader asks to load it. */
@customElement('mux-chat-remote-image')
export class MuxChatRemoteImage extends LitElement {
  @property() src = '';
  @property() alt = '';
  @state() private requested = false;
  @state() private failed = false;

  static styles = css`
    :host { display:block; max-width:100%; margin:8px 0; }
    button { padding:7px 10px; border:1px solid currentColor; border-radius:7px; background:transparent; color:inherit; font:inherit; cursor:pointer; text-align:left; }
    a { display:inline-block; max-width:100%; }
    img { display:block; max-width:100%; max-height:420px; width:auto; height:auto; object-fit:contain; border-radius:7px; }
    .failed { font-size:12px; }
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
      return html`<button type="button" @click=${() => { this.requested = true; }}>Load ${label} from ${url.host}</button>`;
    }
    if (this.failed) {
      return html`<span class="failed">Image could not load. <a href=${this.src} target="_blank" rel="noopener noreferrer nofollow">Open image</a></span>`;
    }
    return html`<a href=${this.src} target="_blank" rel="noopener noreferrer nofollow"><img src=${this.src} alt=${label} loading="lazy" referrerpolicy="no-referrer" @error=${() => { this.failed = true; }}></a>`;
  }
}
