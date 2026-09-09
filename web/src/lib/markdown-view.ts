/**
 * markdown-view.ts -- marked's tokens, rendered as Lit templates.
 *
 * THE SAFETY PROPERTY, AND HOW IT IS OBTAINED. The obvious way to render
 * markdown is to build an HTML string and hand it to unsafeHTML, then hope a
 * sanitizer stays correctly configured forever. This module never builds an
 * HTML string. Every ELEMENT below is a literal in a Lit tagged template, and
 * every piece of model text is an INTERPOLATION, which Lit escapes. Markup in
 * a message is therefore text by construction rather than by an allow-list --
 * there is no innerHTML on this path, no unsafeHTML import, and nothing to
 * misconfigure. Raw HTML tokens are rendered as the characters they are.
 *
 * The one hole Lit does not close is `href`: Lit does not sanitize attribute
 * values, so `[click](javascript:...)` would arrive intact. isSafeHref() is
 * that hole's lid, and it is an allow-list, so a scheme nobody anticipated is
 * refused by default rather than by omission.
 *
 * Rendering is keyed by SEGMENT so that a code block already on screen keeps
 * its DOM node while the code inside it grows. Tearing a <pre> down and
 * rebuilding it on every delta is what streaming markdown normally looks like,
 * and it is why streaming markdown normally flickers.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type { MdSegment, Token } from './markdown-stream';

/**
 * Schemes a link may use.
 *
 * `javascript:` and `data:` URLs are script delivery, not navigation, and this
 * app is served from the same origin as a live terminal multiplexer. A link
 * that silently means "somewhere inside muxterm" is not something a chat
 * message should be able to say either, so relative and protocol-relative
 * forms are refused too.
 */
const SAFE_SCHEMES = ['http://', 'https://', 'mailto:'];

/** True when `url` is an address this pane is willing to make clickable. */
export function isSafeHref(url: string): boolean {
  const u = url.trim().toLowerCase();
  return SAFE_SCHEMES.some((s) => u.startsWith(s));
}

/**
 * The in-tree link and image policy for a PUBLISHED FOLDER page.
 *
 * WHY THIS EXISTS. A wiki is defined by its internal links: `[next](./b.md)`
 * has to be clickable and land on another page of the same published folder,
 * and a screenshot has to actually appear. Both are relative references, and
 * both are refused outright by the rules above -- correctly, in the chat pane
 * this module was written for, where a relative link means "somewhere inside
 * muxterm" and a model-chosen image URL is a beacon.
 *
 * WHY IT IS A PARAMETER AND NOT A FLAG OR A MODULE-LEVEL SETTING. Threading it
 * costs a few signatures; a mutable module-level policy would be one global
 * whose value decides whether an unauthenticated page fetches remote content,
 * and that is exactly the kind of thing that gets set wrong once and stays
 * wrong. Absent -- which is every call the chat pane makes -- behaviour is
 * byte-for-byte what it was before published folders existed.
 *
 * `resolve` is supplied by web/src/public-doc.ts. It returns a same-origin URL
 * when the reference lands INSIDE the publication, and null otherwise, so an
 * absolute `https://tracker.example/x.png` is refused here just as it is in
 * the page's `img-src 'self'` CSP -- two independent mechanisms, either of
 * which is sufficient to stop a published document phoning home.
 */
export interface MdLinkPolicy {
  /** Same-origin URL inside the publication, or null to refuse. */
  resolve(raw: string): string | null;
}

// marked's token shapes are structurally simple but its exported unions are
// awkward to narrow across versions. A local read-only view keeps the casts in
// one place instead of scattered through the render functions.
interface AnyToken {
  type: string;
  text?: string;
  raw?: string;
  tokens?: AnyToken[];
  items?: AnyToken[];
  href?: string;
  lang?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | string;
  header?: TableCell[];
  rows?: TableCell[][];
  align?: (string | null)[];
}

interface TableCell {
  tokens?: AnyToken[];
  align?: string | null;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

function renderInline(tokens: AnyToken[] | undefined, policy?: MdLinkPolicy): unknown[] {
  if (!tokens) return [];
  return tokens.map((t) => renderInlineToken(t, policy));
}

function renderInlineToken(t: AnyToken, policy?: MdLinkPolicy): unknown {
  switch (t.type) {
    case 'text':
      // Nested tokens appear on list-item text; without this, `- **a**` in a
      // tight list would render its own source.
      return t.tokens && t.tokens.length > 0 ? renderInline(t.tokens, policy) : (t.text ?? '');
    case 'escape':
      return t.text ?? '';
    case 'strong':
      return html`<strong>${renderInline(t.tokens, policy)}</strong>`;
    case 'em':
      return html`<em>${renderInline(t.tokens, policy)}</em>`;
    case 'del':
      return html`<s>${renderInline(t.tokens, policy)}</s>`;
    case 'codespan':
      return html`<code class="md-code">${t.text ?? ''}</code>`;
    case 'br':
      return html`<br />`;
    case 'link': {
      const href = t.href ?? '';
      if (isSafeHref(href)) {
        return html`<a
          class="md-link"
          href="${href}"
          target="_blank"
          rel="noopener noreferrer nofollow"
          >${renderInline(t.tokens, policy)}</a
        >`;
      }
      // Inside a published folder, a relative link is the ONE case that is
      // not merely safe but the point: it is how one wiki page reaches the
      // next. It opens in the same tab, because staying in place is what
      // makes a set of documents read as a site rather than as a pile of
      // files. Anything the policy refuses falls through unchanged.
      const inTree = policy?.resolve(href) ?? null;
      if (inTree !== null) {
        return html`<a class="md-link md-link-tree" href="${inTree}" rel="noopener"
          >${renderInline(t.tokens, policy)}</a
        >`;
      }
      // A refused or not-yet-arrived address renders as its own label: the
      // words are readable, nothing is clickable, and no source leaks through.
      return html`<span class="md-nolink">${renderInline(t.tokens, policy)}</span>`;
    }
    case 'image': {
      // An image is drawn ONLY when the policy resolves it to something
      // inside the publication -- a file the publisher published. An absolute
      // or outward-pointing source is still drawn as its alt text and fetched
      // not at all, so a published document cannot become a beacon that
      // reports who opened the link.
      const src = policy?.resolve(t.href ?? '') ?? null;
      if (src !== null) {
        return html`<img class="md-img" src="${src}" alt="${t.text ?? ''}" loading="lazy" />`;
      }
      return html`<span class="md-nolink">${t.text ?? ''}</span>`;
    }
    case 'html':
      // Markup in a message is text. This is the sanitization boundary and it
      // is a rendering decision, not a filter that can be bypassed.
      return t.raw ?? t.text ?? '';
    default:
      return t.raw ?? t.text ?? '';
  }
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function renderBlockToken(t: AnyToken, streaming: boolean, policy?: MdLinkPolicy): unknown {
  switch (t.type) {
    case 'space':
    case 'def':
      return nothing;

    case 'paragraph':
      return html`<p class="md-p">${renderInline(t.tokens, policy)}</p>`;

    case 'text':
      return t.tokens && t.tokens.length > 0
        ? html`<p class="md-p">${renderInline(t.tokens, policy)}</p>`
        : html`<p class="md-p">${t.text ?? ''}</p>`;

    case 'heading': {
      const d = Math.min(Math.max(t.depth ?? 1, 1), 6);
      const kids = renderInline(t.tokens, policy);
      // Six literal templates rather than one built from a string: the element
      // name stays a literal, which is the whole safety argument.
      if (d === 1) return html`<h1 class="md-h">${kids}</h1>`;
      if (d === 2) return html`<h2 class="md-h">${kids}</h2>`;
      if (d === 3) return html`<h3 class="md-h">${kids}</h3>`;
      if (d === 4) return html`<h4 class="md-h">${kids}</h4>`;
      if (d === 5) return html`<h5 class="md-h">${kids}</h5>`;
      return html`<h6 class="md-h">${kids}</h6>`;
    }

    case 'code':
      // data-streaming marks a fence whose closer has not arrived. It is a
      // real signal (tests assert on it) and a styling hook, not decoration.
      return html`<pre
        class="md-pre"
        data-lang="${t.lang || ''}"
        ?data-streaming="${streaming}"
      ><code>${t.text ?? ''}</code></pre>`;

    case 'blockquote':
      return html`<blockquote class="md-quote">
        ${(t.tokens ?? []).map((k) => renderBlockToken(k, false, policy))}
      </blockquote>`;

    case 'hr':
      return html`<hr class="md-hr" />`;

    case 'list': {
      const items = (t.items ?? []).map(
        (it) => html`<li class="md-li">${(it.tokens ?? []).map((k) => renderBlockToken(k, false, policy))}</li>`,
      );
      if (t.ordered) {
        const start = typeof t.start === 'number' ? t.start : 1;
        return html`<ol class="md-ol" start="${start}">
          ${items}
        </ol>`;
      }
      return html`<ul class="md-ul">
        ${items}
      </ul>`;
    }

    case 'table': {
      const align = t.align ?? [];
      const cell = (c: TableCell, i: number, head: boolean): TemplateResult => {
        const a = c.align ?? align[i] ?? '';
        return head
          ? html`<th class="md-th" style="${a ? `text-align:${a}` : ''}">${renderInline(c.tokens, policy)}</th>`
          : html`<td class="md-td" style="${a ? `text-align:${a}` : ''}">${renderInline(c.tokens, policy)}</td>`;
      };
      return html`<div class="md-tablewrap" ?data-streaming="${streaming}">
        <table class="md-table">
          <thead>
            <tr>
              ${(t.header ?? []).map((c, i) => cell(c, i, true))}
            </tr>
          </thead>
          <tbody>
            ${(t.rows ?? []).map(
              (row) => html`<tr>
                ${row.map((c, i) => cell(c, i, false))}
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`;
    }

    case 'html':
      return html`<p class="md-p">${t.raw ?? t.text ?? ''}</p>`;

    default:
      return html`<p class="md-p">${t.raw ?? t.text ?? ''}</p>`;
  }
}

/** Every token in one segment. Only the LAST token of a pending tail is unfinished. */
export function renderTokens(tokens: Token[], pending = false, policy?: MdLinkPolicy): unknown[] {
  const ts = tokens as unknown as AnyToken[];
  return ts.map((t, i) => renderBlockToken(t, pending && i === ts.length - 1, policy));
}

/**
 * The whole message.
 *
 * repeat() with the segment key is what makes ST4 a guarantee rather than a
 * lucky consequence of array order: a closed segment's key never changes, so
 * Lit reuses its DOM instead of rebuilding it when a delta lands at the end.
 */
export function renderSegments(segments: MdSegment[], policy?: MdLinkPolicy): TemplateResult {
  return html`${repeat(
    segments,
    (s) => s.key,
    (s) => html`${renderTokens(s.tokens, s.pending, policy)}`,
  )}`;
}
