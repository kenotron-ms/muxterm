import { apiPath } from './base-path.js';

export interface SDKAttachmentUpload {
  id: string;
  filename: string;
  contentType: string;
  kind: 'image' | 'file';
  size: number;
}

export function uploadSDKAttachment(file: File, signal: AbortSignal, progress: (loaded: number, total: number) => void): Promise<SDKAttachmentUpload> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiPath('/api/sdk-chat-attachments'));
    xhr.responseType = 'json';
    xhr.setRequestHeader('X-Muxterm-Chat-Attachment', '1');
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(event.loaded, event.total); };
    xhr.onerror = () => reject(new Error('The upload could not reach muxterm.'));
    xhr.onabort = () => reject(new DOMException('Attachment cancelled.', 'AbortError'));
    xhr.onload = () => {
      const result = xhr.response as Record<string, unknown> | null;
      if (xhr.status === 201 && result && typeof result.id === 'string') {
        resolve(result as unknown as SDKAttachmentUpload);
      } else {
        reject(new Error(typeof result?.reason === 'string' ? result.reason : `Upload failed (HTTP ${xhr.status}).`));
      }
    };
    signal.addEventListener('abort', () => xhr.abort(), { once:true });
    const form = new FormData(); form.append('file', file, file.name); xhr.send(form);
  });
}

export function discardSDKAttachment(id: string): void {
  void fetch(apiPath(`/api/sdk-chat-attachments/${encodeURIComponent(id)}`), {
    method: 'DELETE', headers: { 'X-Muxterm-Chat-Attachment': '1' },
  });
}
