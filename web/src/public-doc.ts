/**
 * public-doc.ts -- the entire client side of a published document.
 *
 * WHAT THIS IS. muxterm can publish one local file to an anonymous URL
 * (/p/{id}), and a whole directory tree to one anonymous URL whose pages live
 * at /p/{id}/<path inside the folder>. When the thing being served is
 * markdown, the server sends a small shell page with the markdown source
 * embedded as a JSON data script, and this module turns it into a document.
 * See internal/server/publish_api.go and internal/server/publish_folder_api.go.
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
 * IMAGES AND LINKS DEPEND ON WHICH KIND OF PUBLICATION THIS IS, and the page
 * itself says which by emitting a `doc-base` data script or not:
 *
 *   - A SINGLE PUBLISHED FILE emits none. #79's behaviour is kept exactly:
 *     a markdown image draws as its alt text and fetches nothing, relative
 *     links are not clickable. That stops a published document from being a
 *     tracking beacon aimed at whoever opens the link, and the page's CSP says
 *     img-src 'none' to match.
 *
 *   - A PAGE INSIDE A PUBLISHED FOLDER emits the publication's base path, and
 *     gets the in-tree policy below: links and images that resolve INSIDE that
 *     publication work, and everything else is still refused. Without that a
 *     wiki is not a wiki -- its pages cannot reach each other and its
 *     screenshots do not appear. The page's CSP widens to img-src 'self' to
 *     match, and to nothing wider: an image may come from this origin, where
 *     the only thing an anonymous reader can reach is a file the publisher
 *     published.
 *
 * WITHOUT JAVASCRIPT a folder is still browsable: breadcrumbs and directory
 * listings are server-rendered HTML. Only the markdown body needs this module.
 */
import { render } from 'lit';
import { parseMarkdown } from './lib/markdown-stream';
import { renderSegments, type MdLinkPolicy } from './lib/markdown-view';

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

/**
 * The in-tree policy: resolve a reference and keep it only if it lands inside
 * this publication.
 *
 * This is the BROWSER's half of the containment rule. It is not the guarantee
 * -- the server re-proves containment against the pinned root on every single
 * request it receives, and would refuse a link this function wrongly allowed.
 * Its job is to decide what is worth rendering as a link or an image at all,
 * so a reader is not offered addresses that will only answer 404.
 *
 * `base` is the publication root path, always of the form `/p/{id}/`. The
 * trailing slash is what makes the prefix test exact: `/p/{id}evil/...` cannot
 * satisfy it, and neither can `/p/{otherid}/...`.
 */
function inTreePolicy(base: string): MdLinkPolicy {
  return {
    resolve(raw: string): string | null {
      const s = (raw ?? '').trim();
      // An empty href is what markdown-stream.ts reduces a HALF-TYPED link to.
      // Resolving it would produce this very page's URL and make a link that
      // was never finished clickable.
      if (s === '') return null;
      // A bare fragment addresses a heading on this same page. It never
      // leaves the document, so it needs no containment test.
      if (s.startsWith('#')) return s;
      // "//host/path" is an absolute reference to another origin wearing a
      // relative disguise. Refused before URL() can be helpful about it.
      if (s.startsWith('//')) return null;
      let u: URL;
      try {
        u = new URL(s, window.location.href);
      } catch {
        return null;
      }
      // Covers every scheme that is script delivery rather than navigation:
      // `javascript:` and `data:` parse into a URL whose origin is "null",
      // which is never equal to this page's origin.
      if (u.origin !== window.location.origin) return null;
      if (!u.pathname.startsWith(base)) return null;
      return u.pathname + u.search + u.hash;
    },
  };
}

function main(): void {
  const host = document.getElementById('doc');
  // A directory page with no index.md has no document element at all -- its
  // listing is server-rendered and complete. Nothing to do.
  if (!host) return;

  const source = readDataScript('doc-source');
  if (source === null) {
    // The shell always emits the data script, so reaching here means the page
    // was truncated in transit. Say that rather than showing a blank document
    // that reads like an empty file.
    host.textContent = 'This document could not be loaded. Try reloading the page.';
    return;
  }

  const base = readDataScript('doc-base');
  const policy = base ? inTreePolicy(base) : undefined;

  // Lit's render() inserts into the container without clearing what is
  // already there, so the shell's placeholder has to go explicitly -- leaving
  // it produces a document with "This document needs JavaScript to render."
  // printed above it.
  host.replaceChildren();
  render(renderSegments(parseMarkdown(source), policy), host);
}

main();
