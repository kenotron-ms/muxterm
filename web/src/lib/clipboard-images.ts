function namedImages(files: File[]): File[] {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return files.map((file, index) => new File([file],
    `Pasted image ${stamp}${files.length > 1 ? `-${index + 1}` : ''}.${file.type.split('/')[1] || 'png'}`,
    { type: file.type }));
}

/** Mobile paste events may expose files without exposing usable items. */
export function pastedImageFiles(event: ClipboardEvent): File[] {
  const fromItems = Array.from(event.clipboardData?.items || [])
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile()).filter((file): file is File => file !== null);
  const files = fromItems.length ? fromItems : Array.from(event.clipboardData?.files || [])
    .filter(file => file.type.startsWith('image/'));
  return namedImages(files);
}

/** An explicit click keeps clipboard access inside Safari's required user gesture. */
export async function readClipboardImageFiles(): Promise<File[]> {
  if (!navigator.clipboard?.read) throw new Error('Image paste is unavailable in this browser. Choose a file instead.');
  const items = await navigator.clipboard.read();
  const blobs: File[] = [];
  for (const item of items) {
    const type = item.types.find(value => value.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    blobs.push(new File([blob], 'image', { type }));
  }
  if (!blobs.length) throw new Error('The clipboard does not contain an image.');
  return namedImages(blobs);
}
