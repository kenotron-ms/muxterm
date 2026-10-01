import { apiPath } from './base-path.js';
import type { MdLinkPolicy } from './markdown-view.js';

const RASTER_IMAGE = /\.(?:png|jpe?g|gif|webp|avif)$/i;

/** Resolve a local Markdown image through the existing authenticated viewer. */
function localImage(raw: string): string | null {
  const value = raw.trim();
  if ((!value.startsWith('/') || value.startsWith('//')) && !value.startsWith('~/')) return null;
  let path: string;
  try { path = decodeURI(value); }
  catch { return null; }
  if (!RASTER_IMAGE.test(path)) return null;
  return `${apiPath('/api/artifact/raw')}?${new URLSearchParams({ path, max_bytes: String(8 << 20) }).toString()}`;
}

export const chatMarkdownPolicy: MdLinkPolicy = {
  image: localImage,
  remoteImages: true,
};
