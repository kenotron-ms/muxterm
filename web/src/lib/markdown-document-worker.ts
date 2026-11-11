import { parseMarkdown } from './markdown-stream.js';

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<{ source: string }>) => void) | null;
  postMessage: (message: unknown) => void;
};

worker.onmessage = (event) => {
  try {
    worker.postMessage({ segments: parseMarkdown(event.data.source) });
  } catch (error) {
    worker.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
