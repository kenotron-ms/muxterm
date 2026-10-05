import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { terminalRegistry } from '../lib/terminal-registry.js';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';

/** One chat tab owns one terminal container. sessiond and the registry own the PTY. */
@customElement('mux-chat-terminal')
export class MuxChatTerminal extends LitElement {
  @property({ type: Number }) paneId = -1;
  private mountedPane = -1;
  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    const root = this.getRootNode();
    const target = root instanceof ShadowRoot ? root : document.head;
    if (!target.querySelector('#xterm-base-css')) {
      const style = document.createElement('style');
      style.id = 'xterm-base-css'; style.textContent = xtermCss; target.appendChild(style);
    }
  }
  override render() { return html`<div class="chat-terminal-container" style="width:100%;height:100%;min-height:0"></div>`; }
  override updated() {
    if (this.mountedPane === this.paneId) return;
    if (this.mountedPane >= 0) terminalRegistry.detach(this.mountedPane);
    this.mountedPane = this.paneId;
    const container = this.querySelector<HTMLElement>('.chat-terminal-container');
    if (container && this.paneId >= 0) terminalRegistry.setContainer(this.paneId, container, true);
  }
  override disconnectedCallback() {
    if (this.mountedPane >= 0) terminalRegistry.detach(this.mountedPane);
    this.mountedPane = -1;
    super.disconnectedCallback();
  }
}
