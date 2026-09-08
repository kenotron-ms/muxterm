/**
 * public-doc.ts -- the entire client side of a published markdown document.
 *
 * WHAT THIS IS. muxterm can publish one local file to an anonymous URL
 * (/p/{id}). When that file is markdown, the server sends a small shell page
 * with the markdown source embedded as a JSON data script, and this module
 * turns it into a document. See internal/server/publish_api.go.
 *
 * WHY IT REUSES THE CHAT RENDERER RATHER THAN ADDING A SECOND ONE. markdown-
 * view.ts is the renderer merged in #79, and its safety property is exactly
 * what a page serving somebody else's file needs: it never builds an HTML
 * string, every element is a literal in a Lit template and every piece of
 * document text is an interpolation, so markup inside a published file is
 * rendered as the characters it is. A second renderer here would be a second
 * place for that property to be got wrong -- and this one is reachable
 * WITHOUT AUTHENTICATION, which is the last place to accept a fresh sanitizer.
 *
 * WHY THE SOURCE IS EMBEDDED RATHER THAN FETCHED. One request means one
 * identity re-check on the server and no second public route. The bytes are
 * still LIVE: the shell is generated per request from the file on disk, so a
 * reload shows the file as it is now.
 *
 * KNOWN LIMITATION, INHERITED DELIBERATELY. #79's renderer draws a markdown
 * image as its alt text and fetches nothing. In the chat pane that stops a
 * model-chosen URL from phoning home; here it also stops a published document
 * from being a tracking beacon aimed at whoever opens the link. The page's CSP
 * says img-src 'none' to match. Widening one without the other would be a
 * mistake in either direction.
 */
import { render } from 'lit';
import { parseMarkdown } from './lib/markdown-stream';
import { renderSegments } from './lib/markdown-view';

/** Reads a JSON data script by id. Returns null when absent or malformed. */
function readDataScript(id: string): string | null {
  const el = document.getElementById(id);
  if (!el || !el.textContent) return null;
  try {
    const v: unknown = JSON.parse(el.textContent);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function main(): void {
  const host = document.getElementById('doc');
  if (!host) return;

  const source = readDataScript('doc-source');
  if (source === null) {
    // The shell always emits the data script, so reaching here means the page
    // was truncated in transit. Say that rather than showing a blank document
    // that reads like an empty file.
    host.textContent = 'This document could not be loaded. Try reloading the page.';
    return;
  }

  render(renderSegments(parseMarkdown(source)), host);
}

main();
