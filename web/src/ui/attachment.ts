import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { FileText, X } from 'lucide';
import { icon } from '../lib/icons.js';
import './button.js';
import './status-badge.js';

export type AttachmentState = 'ready' | 'uploading' | 'error';

/** A file awaiting a chat send. The owner keeps upload and removal state;
 * this component supplies the shared preview, status, and remove treatment. */
@customElement('mux-ui-attachment')
export class MuxUIAttachment extends LitElement {
  @property({ attribute: 'file-name' }) fileName = '';
  @property({ attribute: 'preview-url' }) previewUrl = '';
  @property({ reflect: true }) state: AttachmentState = 'ready';
  @property() error = '';

  static override styles = css`
    :host {
      box-sizing: border-box;
      display: inline-block;
      width: min(100%, var(--ui-attachment-card-width));
      min-width: 0;
      color: var(--ui-text);
      font-family: var(--ui-font-sans);
    }
    .card {
      box-sizing: border-box;
      position: relative;
      display: flex;
      align-items: center;
      gap: var(--ui-space-3);
      width: 100%;
      min-height: var(--ui-row-touch);
      padding: var(--ui-space-3) var(--ui-control-lg) var(--ui-space-3) var(--ui-space-3);
      border: 1px solid var(--ui-border);
      border-radius: var(--ui-radius-lg);
      background: var(--ui-surface-raised);
    }
    .preview {
      box-sizing: border-box;
      display: grid;
      place-items: center;
      flex: none;
      width: var(--ui-attachment-preview-size);
      height: var(--ui-attachment-preview-size);
      overflow: hidden;
      border-radius: var(--ui-radius-md);
      background: var(--ui-surface-base);
      color: var(--ui-text-muted);
    }
    .preview img { width: 100%; height: 100%; object-fit: cover; }
    .preview svg { width: var(--ui-icon-md); height: var(--ui-icon-md); }
    .copy { min-width: 0; flex: 1; }
    .filename {
      display: block;
      max-width: var(--ui-attachment-name-width);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--ui-text-sm);
      font-weight: 600;
    }
    mux-ui-status-badge {
      display: inline-flex;
      margin-top: var(--ui-space-1);
      max-width: 100%;
      color: var(--ui-text-muted);
      font-size: var(--ui-text-xs);
      line-height: 1.3;
    }
    mux-ui-status-badge[tone='danger'] { color: var(--ui-danger-text); }
    .remove { position: absolute; top: var(--ui-space-2); right: var(--ui-space-2); }
    @media (pointer: coarse) { .remove { top: var(--ui-space-1); right: var(--ui-space-1); } }
  `;

  private requestRemoval(): void {
    this.dispatchEvent(new CustomEvent('attachment-remove', { bubbles: true, composed: true }));
  }

  override render() {
    const status = this.state === 'error' ? this.error || 'Upload failed' : this.state === 'uploading' ? 'Uploading…' : 'Ready';
    const tone = this.state === 'error' ? 'danger' : this.state === 'uploading' ? 'info' : 'neutral';
    return html`<div class="card">
      <span class="preview" aria-hidden="true">${this.previewUrl ? html`<img src=${this.previewUrl} alt="">` : icon(FileText, { size: 20 })}</span>
      <span class="copy"><span class="filename" title=${this.fileName}>${this.fileName}</span>
        <mux-ui-status-badge appearance="plain" tone=${tone} dot wrap role=${this.state === 'error' ? 'alert' : 'status'}>${status}</mux-ui-status-badge>
      </span>
      <mux-ui-button class="remove" icon-only size="small" variant="quiet" accessible-label=${`Remove ${this.fileName}`} tooltip="Remove attachment" @click=${this.requestRemoval}>${icon(X, { size: 14 })}</mux-ui-button>
    </div>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-attachment': MuxUIAttachment } }
