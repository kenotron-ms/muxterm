/**
 * markdown.ts -- assistant message text, rendered as formatting.
 *
 * WHY THIS EXISTS. <mux-cos> printed assistant text through a single Lit
 * interpolation, `html`<p class="say">${text}</p>``. Lit escapes an
 * interpolated string, which is exactly right for safety and exactly wrong for
 * reading: the model writes markdown, so the user saw `**this**` and
 * ```fences``` as literal source.
 *
 * WHY NOT A MARKDOWN LIBRARY. The obvious fix is marked + DOMPurify and
 * unsafeHTML. That buys full CommonMark and pays for it with two dependencies,
 * a sanitizer that must be configured correctly forever, and a permanent
 * `innerHTML` seam carrying model output -- in a session anyone with the web UI
 * open can type into.
 *
 * This module never produces an HTML string. It parses to a small token tree
 * and emits Lit templates whose ELEMENTS are literal and whose TEXT is
 * interpolated. Lit escapes every interpolation, so injected markup is text by
 * construction rather than by a sanitizer's allow-list. There is nothing to
 * misconfigure and no untrusted HTML to sanitize, because none is ever built.
 *
 * SCOPE IS A CLOSED LIST, not "markdown":
 *
 *     bold   italic   inline code   fenced code   links   bullet list   numbered list
 *
 * Anything else -- tables, headings, blockquotes, images, footnotes -- renders
 * as the plain text it already was. That is a deliberate stop, not a to-do: an
 * unsupported construct degrades to exactly today's behaviour, which is a safe
 * place to stand.
 *
 * STREAMING. Text arrives token by token, so this parser is asked to render
 * half-written markdown many times per turn. An unterminated fence renders as a
 * code block in progress rather than as a stray ``` -- the block will simply
 * grow. An unterminated `**` stays literal until its partner arrives, which is
 * the honest reading of what has been said so far.
 */
import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';

// --- link safety -----------------------------------------------------------

/**
 * Schemes a link may use.
 *
 * Lit does not sanitize attribute bindings, so `href` is the ONE place model
 * output could still reach something executable -- `javascript:` and `data:`
 * URLs are script delivery, not navigation. Allow-list rather than deny-list:
 * a scheme nobody has heard of is refused by default instead of by omission.
 *
 * Protocol-relative (`//host`) and root/relative paths are refused too. This
 * app is served from the same origin as a live terminal multiplexer; a link
 * that silently means "somewhere inside muxterm" is not what a chat message
 * asking you to click it should be able to say.
 */
const SAFE_SCHEMES = ['http://', 'https://', 'mailto:'];

/** True when `url` is a link we are willing to make clickable. */
export function isSafeHref(url: string): boolean {
  const u = url.trim().toLowerCase();
  return SAFE_SCHEMES.some((s) => u.startsWith(s));
}

// --- inline ----------------------------------------------------------------

type Inline =
  | { k: 'text'; v: string }
  | { k: 'code'; v: string }
  | { k: 'strong'; kids: Inline[] }
  | { k: 'em'; kids: Inline[] }
  | { k: 'link'; href: string; kids: Inline[] };

/**
 * The inline rules.
 *
 * `pre` is a leading group that matches the character BEFORE the delimiter.
 * That is how the underscore rules refuse intraword matches without a
 * lookbehind -- `(?<=...)` is fine in every current engine but has a Safari
 * floor this app has no reason to inherit. The group is consumed by the match
 * and given back as `start`, so callers never see it.
 *
 * Underscore emphasis refuses a letter, digit, or `_` on either side, so
 * `snake_case_name` keeps its underscores. That false positive shows up
 * constantly in text about code, which is most of what this surface carries.
 * Asterisk emphasis only refuses whitespace next to the delimiter, so
 * `2 * 3 * 4` stays arithmetic.
 */
const RULES = [
  // Code span. Highest priority at a tied start: inside backticks, `**` is two
  // asterisks and `[x](y)` is not a link.
  { kind: 'code', pre: false, re: /`([^`\n]+)`/ },
  // Link text may not contain `]` or a newline; the target may not contain a
  // space, `)`, or a newline. Both keep a match on one plausible link instead
  // of letting a stray bracket swallow a paragraph.
  { kind: 'link', pre: false, re: /\[([^\]\n]*)\]\(([^)\s\n]*)\)/ },
  { kind: 'strong', pre: true, re: /(^|[^*])\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/ },
  { kind: 'strong', pre: true, re: /(^|[^A-Za-z0-9_])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])/ },
  { kind: 'em', pre: true, re: /(^|[^*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/ },
  { kind: 'em', pre: true, re: /(^|[^A-Za-z0-9_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![A-Za-z0-9_])/ },
] as const;

/**
 * Parse inline markdown into a token tree.
 *
 * EARLIEST match wins, not highest-priority rule. Priority only breaks a tie at
 * the same start offset. Scanning by rule instead would mis-read ``**a `b` c**``
 * -- a code span later in the line would claim the middle and leave the bold
 * delimiters orphaned on either side of it.
 */
function parseInline(src: string): Inline[] {
  if (src === '') return [];

  let best: { start: number; end: number; rule: (typeof RULES)[number]; m: RegExpExecArray } | null = null;
  for (const rule of RULES) {
    const m = rule.re.exec(src);
    if (!m) continue;
    const start = m.index + (rule.pre ? m[1].length : 0);
    if (best === null || start < best.start) best = { start, end: m.index + m[0].length, rule, m };
  }
  if (!best) return [{ k: 'text', v: src }];

  const { start, end, rule, m } = best;
  const before = src.slice(0, start);
  const after = src.slice(end);

  let node: Inline;
  if (rule.kind === 'code') {
    node = { k: 'code', v: m[1] };
  } else if (rule.kind === 'link') {
    const href = m[2];
    // An unsafe or empty target is not an error and not a hole: the link
    // renders as its own source text, so the user still reads the sentence.
    // Dropping it would be a silent edit of what the model said.
    node = isSafeHref(href)
      ? { k: 'link', href, kids: parseInline(m[1]) }
      : { k: 'text', v: m[0] };
  } else {
    node = { k: rule.kind, kids: parseInline(m[2]) };
  }

  return [...parseInline(before), node, ...parseInline(after)];
}

/**
 * Inline tokens -> Lit templates.
 *
 * Every `v` and every `href` below is an INTERPOLATION. Lit escapes text
 * bindings and quotes attribute bindings; no template string here is ever
 * assembled from input.
 */
function inlineTemplates(nodes: Inline[]): unknown[] {
  return nodes.map((n) => {
    switch (n.k) {
      case 'text':
        return n.v;
      case 'code':
        return html`<code>${n.v}</code>`;
      case 'strong':
        return html`<strong>${inlineTemplates(n.kids)}</strong>`;
      case 'em':
        return html`<em>${inlineTemplates(n.kids)}</em>`;
      case 'link':
        // rel="noopener noreferrer": a target=_blank link from model output
        // must not hand the opener to whatever it points at.
        return html`<a
          href="${n.href}"
          target="_blank"
          rel="noopener noreferrer"
          >${n.kids.length ? inlineTemplates(n.kids) : n.href}</a
        >`;
    }
  });
}

/** Render one line/run of inline markdown. Exported for tests. */
export function renderInline(src: string): unknown[] {
  return inlineTemplates(parseInline(src));
}

// --- blocks ----------------------------------------------------------------

type Block =
  | { k: 'p'; lines: string[] }
  | { k: 'fence'; lang: string; lines: string[] }
  | { k: 'ul'; items: string[] }
  | { k: 'ol'; items: string[] };

const FENCE_RE = /^\s{0,3}(```|~~~)\s*([^\s`]*)\s*$/;
const BULLET_RE = /^\s{0,3}[-*+][ \t]+(.*)$/;
const ORDERED_RE = /^\s{0,3}\d{1,9}[.)][ \t]+(.*)$/;

/** Split source into block tokens. */
function parseBlocks(src: string): Block[] {
  const lines = src.split('\n');
  const out: Block[] = [];
  let i = 0;

  const flushPara = (buf: string[]) => {
    if (buf.length) out.push({ k: 'p', lines: [...buf] });
    buf.length = 0;
  };
  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara(para);
      const marker = fence[1];
      const body: string[] = [];
      i++;
      // Mid-stream the closing fence has not been typed yet. Consuming to the
      // end is the reading that keeps a growing code block a code block
      // instead of flickering back to a paragraph on every token.
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // step over the closing fence (or past the end, harmlessly)
      out.push({ k: 'fence', lang: fence[2] || '', lines: body });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushPara(para);
      const items: string[] = [];
      while (i < lines.length) {
        const m = BULLET_RE.exec(lines[i]);
        if (m) {
          items.push(m[1]);
          i++;
          continue;
        }
        // A non-blank, non-marker line directly under an item is that item's
        // continuation (a wrapped bullet), not a new paragraph.
        if (items.length && lines[i].trim() !== '' && !ORDERED_RE.test(lines[i]) && !FENCE_RE.test(lines[i])) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i++;
          continue;
        }
        break;
      }
      out.push({ k: 'ul', items });
      continue;
    }

    const ordered = ORDERED_RE.exec(line);
    if (ordered) {
      flushPara(para);
      const items: string[] = [];
      while (i < lines.length) {
        const m = ORDERED_RE.exec(lines[i]);
        if (m) {
          items.push(m[1]);
          i++;
          continue;
        }
        if (items.length && lines[i].trim() !== '' && !BULLET_RE.test(lines[i]) && !FENCE_RE.test(lines[i])) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i++;
          continue;
        }
        break;
      }
      out.push({ k: 'ol', items });
      continue;
    }

    if (line.trim() === '') {
      flushPara(para);
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara(para);
  return out;
}

/**
 * Render markdown as a list of block-level Lit templates.
 *
 * The caller supplies the container. It must NOT be a `<p>`: a `<ul>` or
 * `<pre>` inside one is invalid HTML, the browser closes the paragraph early,
 * and Lit's parts then point at nodes that moved.
 */
export function renderMarkdown(src: string): unknown {
  if (!src) return nothing;
  return parseBlocks(src).map((b): TemplateResult => {
    switch (b.k) {
      case 'fence':
        // No highlighting and no language class doing anything yet; `lang` is
        // carried as a data attribute so a future theme can use it without
        // this parser changing shape.
        return html`<pre data-lang="${b.lang || nothing}"><code>${b.lines.join('\n')}</code></pre>`;
      case 'ul':
        return html`<ul>
          ${b.items.map((it) => html`<li>${renderInline(it)}</li>`)}
        </ul>`;
      case 'ol':
        return html`<ol>
          ${b.items.map((it) => html`<li>${renderInline(it)}</li>`)}
        </ol>`;
      case 'p':
        // Soft line breaks are preserved by CSS `white-space: pre-wrap` on the
        // paragraph, which is what the surface did before markdown existed.
        // Keeping that means turning markdown on did not silently re-flow
        // everything anyone had already read.
        return html`<p>${renderInline(b.lines.join('\n'))}</p>`;
    }
  });
}
