/**
 * markdown-stream.ts -- markdown parsing for text that has not finished arriving.
 *
 * WHY THIS EXISTS. <mux-cos> printed assistant text through one Lit
 * interpolation, `html`<p class="say">${text}</p>``. Lit escapes an
 * interpolated string -- correct for safety, wrong for reading, because the
 * model writes markdown and the user saw `**this**` as literal source.
 *
 * The naive fix (re-parse the whole message on every delta) is wrong here for a
 * reason this repo has already paid for: the same event path shipped an
 * O(n squared) render that had to be found and fixed. Text arrives token by
 * token, so "parse it all again" is quadratic by construction.
 *
 * THE SHAPE OF THE FIX. Markdown is a sequence of blocks, and a block that has
 * been closed by later text can never be reopened by text that arrives after
 * it. So the message is split into SEGMENTS at boundaries that are PROVEN --
 * a boundary is recorded only once the text already seen makes it certain --
 * and every closed segment is lexed exactly once and cached forever. Only the
 * final, still-growing segment is re-lexed as deltas land.
 *
 *     [ closed ][ closed ][ closed ][ open, re-lexed ]
 *       cached    cached    cached     <- deltas land here
 *
 * THE TAIL IS SPECULATIVELY CLOSED. Half-written markdown is not markdown.
 * `**bold` with its partner still in flight lexes as the literal characters
 * `**bold`, which flashes punctuation at the reader and then yanks it away. So
 * while the stream is live the open segment is completed before lexing -- a
 * dangling `**` gets its closer, a header row with no delimiter row yet gets
 * one, a half-typed link is neutralised into its own label. The reader sees
 * the construct it is becoming, never the source it is made of.
 *
 * CONVERGENCE IS A THEOREM, NOT A HOPE. Speculation is a property of the
 * `streaming` argument, not of the cache: `update(text, false)` performs no
 * speculation at all. Because parseMarkdown(text) is literally
 * `new MarkdownStream().update(text, false)`, a stream that finishes and a
 * paste of the same text run the same code on the same input. The only thing
 * that could break the equality is the cache, which is what the fuzz test in
 * markdown-stream.test.ts exists to attack.
 *
 * NO HTML IS EVER BUILT HERE. This module emits marked's TOKENS, never an HTML
 * string. Turning tokens into DOM is markdown-view.ts's job, and it does it
 * with Lit templates whose elements are literal and whose text is interpolated.
 * There is no innerHTML seam on this path and so nothing to sanitize.
 */
import { marked, type Token, type Tokens } from 'marked';

/**
 * How the block lexer is configured. `gfm` is what makes tables exist at all;
 * `breaks` makes a single newline a line break, which is what a chat reader
 * means when they press enter once.
 */
const LEX_OPTIONS = { gfm: true, breaks: true, pedantic: false } as const;

/** One cache unit: a run of source that lexes independently of its neighbours. */
export interface MdSegment {
  /**
   * Identity for keyed rendering. Assigned once, never reused, never changed --
   * this is what lets Lit's repeat() keep a code block's DOM node alive while
   * the code inside it grows.
   */
  key: number;
  /** marked's tokens for this segment. */
  tokens: Token[];
  /**
   * True when this segment's LAST construct is unterminated -- an open fence,
   * a table whose delimiter row was synthesized, an emphasis run whose partner
   * has not landed. Not merely "this is the tail": a closed fence at the end of
   * a live message is finished, and saying otherwise would make the flag mean
   * nothing.
   */
  pending: boolean;
}

/**
 * Work counters. These exist to be asserted on: "render cost is linear" is a
 * claim about numbers, so the numbers are exported and the test measures them.
 */
export interface MdStats {
  /** Characters the boundary scanner has looked at. */
  charsScanned: number;
  /** Characters handed to the block lexer. The cost meter that matters. */
  charsLexed: number;
  /** Times any segment was lexed. */
  segmentLexes: number;
  /** Times the whole cache was thrown away and rebuilt. */
  fullResets: number;
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

const BLANK = /^[ \t]*$/;
/** ```lang or ~~~lang, indented up to three spaces (four would be code). */
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
/** `- x`, `* x`, `+ x`, `1. x`, `1) x` -- the start of a list item. */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

function isBlank(line: string): boolean {
  return BLANK.test(line);
}

/** A line that could continue a list already in progress across a blank line. */
function continuesList(line: string): boolean {
  return LIST_ITEM.test(line) || /^ {2,}\S/.test(line);
}

/** The closing partner of an open fence: same char, at least as long, nothing else. */
function closesFence(line: string, marker: string): boolean {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return m !== null && m[1][0] === marker[0] && m[1].length >= marker.length;
}

// ---------------------------------------------------------------------------
// Speculative completion of the open tail
// ---------------------------------------------------------------------------

/** A pipe-led line -- deliberately strict, so prose containing "a | b" is not a table. */
function looksLikeTableRow(line: string): boolean {
  return /^ {0,3}\|/.test(line);
}

/** True once a pipe-led line has some actual cell content to show. */
function hasCellContent(line: string): boolean {
  return line.replace(/\|/g, '').trim() !== '';
}

/** A delimiter row, complete or still being typed: only pipes, dashes, colons, space. */
function isDelimiterish(line: string): boolean {
  return /^ {0,3}\|[ \t:|-]*$/.test(line);
}

/** `| --- | --- |` in full, with the right number of cells for its header. */
function isUsableDelimiterRow(line: string, cells: number): boolean {
  return (
    /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line) &&
    line.includes('-') &&
    countCells(line) === cells
  );
}

/** How many cells a pipe-delimited row declares. */
function countCells(line: string): number {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').length;
}

function delimiterRow(cells: number): string {
  return '|' + ' --- |'.repeat(Math.max(cells, 1));
}

/**
 * Give a table-in-progress the delimiter row it has not typed yet.
 *
 * Without this, `| name | size |` on its own lexes as a PARAGRAPH containing
 * literal pipe characters: the reader watches a row of punctuation sit there
 * and then vanish when the table finally forms. GFM will not see a table until
 * the delimiter row is complete AND its cell count matches the header, so the
 * synthesized row is rebuilt from the header on every delta rather than
 * trusted once.
 *
 * Returns the source to lex, '' to show nothing yet, or null when this is not
 * a table at all.
 */
function completeTable(tail: string): string | null {
  const lines = tail.split('\n');
  while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
  if (lines.length === 0) return null;
  if (!looksLikeTableRow(lines[0])) return null;

  // A bare `|` is not yet a table and is not worth showing as a pipe. Same
  // rule as an emphasis opener with nothing after it: show nothing, not source.
  if (!hasCellContent(lines[0])) return '';

  const cells = countCells(lines[0]);
  if (lines.length === 1) return lines[0] + '\n' + delimiterRow(cells);
  if (!isDelimiterish(lines[1])) return null; // second line is not a delimiter row
  if (isUsableDelimiterRow(lines[1], cells)) return null; // marked can see it already

  return [lines[0], delimiterRow(cells), ...lines.slice(2)].join('\n');
}

const ALNUM = /[0-9A-Za-z]/;
const SPACE = /\s/;

/** An open inline delimiter and where it started. */
interface OpenDelim {
  at: number;
  d: string;
}

/**
 * Close the inline constructs the tail has opened but not finished.
 *
 * WHEN THIS DOES NOTHING. If every delimiter in the tail is already balanced,
 * the tail is returned unchanged and marked decides everything. Speculation
 * only ever touches text the reader would otherwise see as punctuation.
 *
 * EMPHASIS AND CODE SPANS get their partner appended, so nothing already on
 * screen moves when the real partner arrives -- the closing `**` lands where
 * the speculative one already was. Two details make that work rather than
 * merely look like it works:
 *
 *   - An opener with nothing after it yet (`**` at the very end) is REMOVED,
 *     not closed. `** **` is not emphasis in CommonMark, so closing an empty
 *     opener would put the literal asterisks straight back on screen.
 *   - Closers are appended against the last non-space character, because a
 *     closing `**` preceded by a space is not a closer either.
 *
 * WHAT IS DELIBERATELY NOT SPECULATED. An opener must sit on a word boundary:
 * a `*` right after a letter or digit is left alone. Without that rule `2*3`
 * would briefly become "2" and italic "3", and `some_var` would sprout a
 * second underscore. Real emphasis opens at a word boundary; arithmetic and
 * snake_case do not.
 *
 * LINKS ARE CUT, NOT CLOSED. Appending `)` to `[docs](https://exa` would
 * publish a clickable link to a truncated address. A half-typed link is
 * instead reduced to `[docs]()`, whose empty href markdown-view.ts refuses to
 * make clickable and renders as its own label. The reader sees the words
 * immediately; the link arrives with the address.
 */
function completeInline(tail: string): string {
  const open: OpenDelim[] = [];
  const inCode = (): boolean => open.length > 0 && open[open.length - 1].d[0] === '`';

  let linkTextAt = -1; // offset of an unmatched '['
  let linkHrefAt = -1; // offset of the '[' whose '](' has no ')'
  let linkCloseAt = -1; // offset of a ']' at the very end, partner still unknown
  let partialAt = -1; // offset of a half-arrived closing delimiter run

  let i = 0;
  while (i < tail.length) {
    const c = tail[i];

    if (c === '\\') {
      i += 2;
      continue;
    }

    if (c === '`') {
      let n = 0;
      while (tail[i + n] === '`') n++;
      const run = '`'.repeat(n);
      if (!inCode()) open.push({ at: i, d: run });
      else if (open[open.length - 1].d === run) open.pop();
      i += n;
      continue;
    }

    // Inside a code span every other character is content, not syntax.
    if (inCode()) {
      i++;
      continue;
    }

    if (c === '*' || c === '_') {
      let n = 0;
      while (tail[i + n] === c) n++;
      const run = c.repeat(Math.min(n, 2));
      const prev = tail[i - 1];
      const next = tail[i + n];
      const top = open[open.length - 1];

      // A closer arriving one character at a time: `**loud` then `*`. Treated
      // as an opener it would put a literal asterisk on screen for exactly one
      // delta, which is the flicker this whole function exists to remove.
      if (i + n === tail.length && top && top.d[0] === c && top.d !== run) {
        partialAt = i;
        break;
      }

      if (top && top.d === run && !(prev !== undefined && SPACE.test(prev))) {
        open.pop();
      } else if (
        !(prev !== undefined && ALNUM.test(prev)) &&
        !(next !== undefined && SPACE.test(next))
      ) {
        open.push({ at: i, d: run });
      }
      i += n;
      continue;
    }

    if (c === '[') {
      linkTextAt = i;
      i++;
      continue;
    }
    if (c === ']' && linkTextAt >= 0) {
      if (tail[i + 1] === '(') {
        linkHrefAt = linkTextAt;
        linkTextAt = -1;
        i += 2;
        continue;
      }
      // At the very end we cannot yet know whether an address follows. Keep
      // the link open rather than publishing a bracket the next delta removes.
      if (i + 1 === tail.length) {
        linkCloseAt = i;
        break;
      }
      linkTextAt = -1;
      i++;
      continue;
    }
    if (c === ')' && linkHrefAt >= 0) {
      linkHrefAt = -1;
      i++;
      continue;
    }

    i++;
  }

  // 1. Drop a closing delimiter that has only half arrived.
  let body = partialAt >= 0 ? tail.slice(0, partialAt) : tail;

  // 2. Reduce a half-typed link to its label.
  let suffix = '';
  if (linkHrefAt >= 0) {
    const cut = tail.indexOf('](', linkHrefAt);
    body = tail.slice(0, cut);
    suffix = ']()';
    while (open.length > 0 && open[open.length - 1].at >= cut) open.pop();
  } else if (linkTextAt >= 0) {
    body = linkCloseAt >= 0 ? tail.slice(0, linkCloseAt) : body;
    suffix = ']()';
  }

  // 3. Drop openers that have not been given anything to emphasise yet.
  for (;;) {
    const top = open[open.length - 1];
    if (!top) break;
    if (top.at >= body.length) {
      open.pop();
      continue;
    }
    if (body.slice(top.at + top.d.length).trim() !== '') break;
    body = body.slice(0, top.at);
    open.pop();
  }

  // 4. Close what is left, innermost first, against real content.
  if (open.length > 0) {
    const ws = body.match(/\s+$/)?.[0] ?? '';
    let closed = ws === '' ? body : body.slice(0, body.length - ws.length);
    for (let k = open.length - 1; k >= 0; k--) closed += open[k].d;
    body = closed + ws;
  }

  return body + suffix;
}

/** True when the source's last fence is still open. */
function endsInsideFence(src: string): { open: boolean; marker: string; infoLine: string } {
  let marker = '';
  let infoLine = '';
  for (const line of src.split('\n')) {
    if (marker === '') {
      const m = line.match(FENCE_OPEN);
      if (m) {
        marker = m[2];
        infoLine = m[3];
      }
    } else if (closesFence(line, marker)) {
      marker = '';
      infoLine = '';
    }
  }
  return { open: marker !== '', marker, infoLine };
}

/** marked's `code` token, built by slicing rather than by lexing. */
interface CodeToken {
  type: 'code';
  raw: string;
  lang: string;
  text: string;
}

/**
 * The token for a segment that is nothing but an unterminated fence.
 *
 * Returns null unless the fence opens at the very start of the segment with no
 * indent, which is the only shape simple enough to be certain about. Everything
 * else -- a fence inside a list item, an indented fence -- goes back to marked.
 */
export function fastFenceToken(src: string): CodeToken | null {
  const m = src.match(/^(`{3,}|~{3,})([^\n]*)(\n?)([\s\S]*)$/);
  if (!m) return null;
  const info = m[2];
  // An info string may not contain a backtick when the fence is backticks.
  if (m[1][0] === '`' && info.includes('`')) return null;
  const body = m[3] === '' ? '' : m[4].replace(/\n$/, '');
  return { type: 'code', raw: src, lang: info.trim(), text: body };
}

/**
 * The one place speculation happens. Pure function of the tail; called only
 * while `streaming` is true, which is why a finished stream and a paste cannot
 * disagree.
 */
export function speculate(tail: string): string {
  const fence = endsInsideFence(tail);
  // Inside a fence the characters are content, not syntax. marked already
  // treats an unterminated fence as a code block that runs to the end, which
  // is exactly the "code block in progress" the reader should see.
  if (fence.open) return tail;

  const table = completeTable(tail);
  if (table !== null) return table;

  return completeInline(tail);
}

// ---------------------------------------------------------------------------
// The incremental parser
// ---------------------------------------------------------------------------

let nextKey = 1;

interface ClosedSegment {
  key: number;
  tokens: Token[];
  /** Offset one past the end of this segment in the source. */
  end: number;
}

/**
 * Parses a message that is still being written.
 *
 * One instance per assistant text block, held in a WeakMap keyed by the block
 * object so it lives exactly as long as the block does. Feed it the FULL text
 * known so far on every render; appending is cheap because everything already
 * closed is already parsed.
 */
export class MarkdownStream {
  private _src = '';
  private _closed: ClosedSegment[] = [];
  /** Offset where the still-open segment begins. */
  private _segStart = 0;
  /** Offset the scanner has consumed up to. Never inside a partial line. */
  private _scanPos = 0;

  // Scanner state, carried across calls so no character is scanned twice.
  private _fence = '';
  private _sawContent = false;
  private _listLike = false;
  private _blankAt = -1;

  // The open segment's cache: re-lexing is skipped when its source is unchanged.
  private _openKey = nextKey++;
  private _openSrc: string | null = null;
  private _openTokens: Token[] = [];
  private _openWasStreaming = false;

  private _stats: MdStats = { charsScanned: 0, charsLexed: 0, segmentLexes: 0, fullResets: 0 };

  get stats(): Readonly<MdStats> {
    return this._stats;
  }

  /**
   * Parse `text`, returning every segment in order.
   *
   * `streaming` false means the message is final: no speculation is applied,
   * so the result is exactly what a one-pass parse of the same text produces.
   */
  update(text: string, streaming: boolean): MdSegment[] {
    if (!this._isAppendOf(text)) this._reset();
    this._src = text;

    this._scan();

    const tailSrc = this._src.slice(this._segStart);
    const fence = endsInsideFence(tailSrc);
    const lexSrc = streaming ? speculate(tailSrc) : tailSrc;

    if (this._openSrc !== lexSrc || this._openWasStreaming !== streaming) {
      this._openTokens = this._lexTail(lexSrc, fence.open);
      this._openSrc = lexSrc;
      this._openWasStreaming = streaming;
    }

    const out: MdSegment[] = this._closed.map((s) => ({
      key: s.key,
      tokens: s.tokens,
      pending: false,
    }));
    if (this._openTokens.length > 0) {
      out.push({
        key: this._openKey,
        tokens: this._openTokens,
        pending: streaming && (fence.open || lexSrc !== tailSrc),
      });
    }
    return out;
  }

  private _lex(src: string): Token[] {
    if (src === '') return [];
    this._stats.charsLexed += src.length;
    this._stats.segmentLexes += 1;
    return marked.lexer(src, LEX_OPTIONS) as Token[];
  }

  /**
   * Lex the open tail, taking the one shortcut that actually matters.
   *
   * A fenced block streams in as one segment that can reach many kilobytes, and
   * re-lexing all of it on every delta is quadratic IN THE BLOCK even though it
   * is linear in the number of segments. But an unterminated fence has exactly
   * one possible parse -- an info line and a body -- so the token can be built
   * by slicing instead. There is no cleverness to get wrong, only a rule to
   * match, and markdown-stream.test.ts asserts the two agree token for token.
   */
  private _lexTail(src: string, insideFence: boolean): Token[] {
    if (insideFence) {
      const fast = fastFenceToken(src);
      if (fast) return [fast as unknown as Token];
    }
    return this._lex(src);
  }

  /**
   * Is `text` this instance's source with more appended?
   *
   * The caller appends: cos-store either does `block.text += delta` on the same
   * object or pushes a NEW block object (which gets its own MarkdownStream via
   * the WeakMap). So divergence should be impossible on the real path, and this
   * is a cheap net rather than a proof -- a full prefix compare would be O(n)
   * per delta, reintroducing on the guard the very quadratic this class exists
   * to remove. A miss costs correctness, so the net checks three places any
   * wholesale replacement would have to survive: the length must not shrink,
   * and the head and the previous end must both still be there.
   */
  private _isAppendOf(text: string): boolean {
    const n = this._src.length;
    if (n === 0) return true;
    if (text.length < n) return false;
    const w = Math.min(64, n);
    if (text.slice(n - w, n) !== this._src.slice(n - w)) return false;
    if (text.slice(0, w) !== this._src.slice(0, w)) return false;
    return true;
  }

  private _reset(): void {
    this._stats.fullResets += 1;
    this._closed = [];
    this._segStart = 0;
    this._scanPos = 0;
    this._fence = '';
    this._sawContent = false;
    this._listLike = false;
    this._blankAt = -1;
    this._openKey = nextKey++;
    this._openSrc = null;
    this._openTokens = [];
    this._src = '';
  }

  /**
   * Advance over newly arrived text, closing segments whose boundaries the text
   * already seen has PROVEN.
   *
   * A blank line alone proves nothing -- markdown lets an indented line after a
   * blank keep a list going. The proof is a blank line FOLLOWED BY content that
   * does not continue what came before. That is why _blankAt is remembered and
   * acted on later rather than cut at immediately, and it is what makes a
   * closed segment safe to cache forever.
   *
   * A line with no newline yet is not classified: `-` might still become
   * `- item`. The scanner stops before it and re-reads it next time, which
   * costs one line, not one message.
   */
  private _scan(): void {
    let i = this._scanPos;
    const src = this._src;

    while (i < src.length) {
      const nl = src.indexOf('\n', i);
      const complete = nl >= 0;
      const line = complete ? src.slice(i, nl) : src.slice(i);
      const next = complete ? nl + 1 : src.length;

      // A partial line can still PROVE a pending boundary when it is plainly
      // content and the segment before it was not a list -- a blank line
      // followed by any non-space character ends a paragraph, whatever the
      // rest of the line turns out to say.
      if (!complete) {
        if (this._blankAt >= 0 && !this._listLike && !isBlank(line) && this._fence === '') {
          this._closeAt(this._blankAt);
        }
        break;
      }

      this._stats.charsScanned += next - i;

      if (this._fence !== '') {
        if (closesFence(line, this._fence)) this._fence = '';
        i = next;
        continue;
      }

      if (isBlank(line)) {
        if (this._sawContent) this._blankAt = next;
        i = next;
        continue;
      }

      // Non-blank line. Settle any boundary the blank run left pending.
      if (this._blankAt >= 0) {
        if (!this._listLike || !continuesList(line)) this._closeAt(this._blankAt);
        else this._blankAt = -1;
      }

      if (!this._sawContent) {
        this._sawContent = true;
        this._listLike = LIST_ITEM.test(line);
      }

      const fm = line.match(FENCE_OPEN);
      if (fm) this._fence = fm[2];

      i = next;
    }

    this._scanPos = i;
  }

  /** Freeze [segStart, end) as a closed segment and start a new one there. */
  private _closeAt(end: number): void {
    const src = this._src.slice(this._segStart, end);
    if (src.trim() !== '') {
      this._closed.push({ key: this._openKey, tokens: this._lex(src), end });
      this._openKey = nextKey++;
    }
    this._segStart = end;
    this._sawContent = false;
    this._listLike = false;
    this._blankAt = -1;
    this._openSrc = null;
    this._openTokens = [];
  }
}

/**
 * Parse a complete message in one pass -- what "pasted in" means.
 *
 * Defined in terms of MarkdownStream on purpose: streamed-then-finished and
 * pasted are not two implementations that must be kept in agreement, they are
 * one implementation reached by two routes.
 */
export function parseMarkdown(text: string): MdSegment[] {
  return new MarkdownStream().update(text, false);
}

export type { Token, Tokens };
