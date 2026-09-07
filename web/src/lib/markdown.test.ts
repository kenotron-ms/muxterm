/**
 * markdown.test.ts -- D2's closed list, checked against RENDERED DOM.
 *
 * These tests render into a real (happy-dom) tree rather than asserting on a
 * token structure, because the claim under test is "the user sees formatting",
 * not "the parser produced a node". A token assertion would still pass if the
 * template emitted nothing.
 *
 * The safety tests are the load-bearing ones. Their claim is not "the sanitizer
 * is configured well" -- there is no sanitizer -- it is that no code path can
 * put model output into innerHTML at all.
 */
import { describe, it, expect } from 'vitest';
import { render, html } from 'lit';
import { renderMarkdown, isSafeHref } from './markdown.js';

function draw(src: string): HTMLElement {
  const host = document.createElement('div');
  render(html`<div class="md">${renderMarkdown(src)}</div>`, host);
  return host.firstElementChild as HTMLElement;
}

describe('renderMarkdown -- the closed list', () => {
  it('bold', () => {
    const el = draw('a **bold** word');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.textContent).toBe('a bold word');
  });

  it('bold with underscores', () => {
    expect(draw('a __bold__ word').querySelector('strong')?.textContent).toBe('bold');
  });

  it('italic', () => {
    const el = draw('an *italic* word');
    expect(el.querySelector('em')?.textContent).toBe('italic');
    expect(el.textContent).toBe('an italic word');
  });

  it('italic with underscores', () => {
    expect(draw('an _italic_ word').querySelector('em')?.textContent).toBe('italic');
  });

  it('inline code', () => {
    const el = draw('run `make dev-local` now');
    expect(el.querySelector('code')?.textContent).toBe('make dev-local');
    expect(el.querySelector('pre')).toBeNull();
  });

  it('fenced code block', () => {
    const el = draw('before\n\n```sh\ngo build ./...\ngo vet ./...\n```\n\nafter');
    const pre = el.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.querySelector('code')?.textContent).toBe('go build ./...\ngo vet ./...');
    expect(pre?.getAttribute('data-lang')).toBe('sh');
    expect(el.querySelectorAll('p')).toHaveLength(2);
  });

  it('fenced code block with no language', () => {
    const el = draw('```\nplain\n```');
    expect(el.querySelector('pre code')?.textContent).toBe('plain');
  });

  it('link', () => {
    const a = draw('see [the repo](https://github.com/kenotron-ms/muxterm) for more')
      .querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://github.com/kenotron-ms/muxterm');
    expect(a?.textContent).toBe('the repo');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.getAttribute('target')).toBe('_blank');
  });

  it('bullet list', () => {
    const el = draw('- one\n- two\n- three');
    const items = el.querySelectorAll('ul li');
    expect(items).toHaveLength(3);
    expect([...items].map((li) => li.textContent)).toEqual(['one', 'two', 'three']);
    expect(el.querySelector('ol')).toBeNull();
  });

  it('numbered list', () => {
    const el = draw('1. first\n2. second');
    const items = el.querySelectorAll('ol li');
    expect(items).toHaveLength(2);
    expect([...items].map((li) => li.textContent)).toEqual(['first', 'second']);
    expect(el.querySelector('ul')).toBeNull();
  });

  it('formats inside list items', () => {
    const el = draw('- a **bold** item with `code`');
    expect(el.querySelector('li strong')?.textContent).toBe('bold');
    expect(el.querySelector('li code')?.textContent).toBe('code');
  });
});

describe('renderMarkdown -- no untrusted HTML reaches innerHTML', () => {
  it('renders raw tags as text, not as elements', () => {
    const el = draw('<img src=x onerror=alert(1)> and <b>not bold</b>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.textContent).toContain('<b>not bold</b>');
  });

  it('renders a script tag as text', () => {
    const el = draw('```\n<script>alert(1)</script>\n```');
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('pre code')?.textContent).toBe('<script>alert(1)</script>');
  });

  it('refuses javascript: links, keeping the text visible', () => {
    const el = draw('[click me](javascript:alert(1))');
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toBe('[click me](javascript:alert(1))');
  });

  it('refuses data: links', () => {
    expect(draw('[x](data:text/html,<script>alert(1)</script>)').querySelector('a')).toBeNull();
  });

  it('isSafeHref allows only http, https and mailto', () => {
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('http://example.com')).toBe(true);
    expect(isSafeHref('mailto:a@b.c')).toBe(true);
    expect(isSafeHref('JavaScript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,x')).toBe(false);
    expect(isSafeHref('//evil.example')).toBe(false);
    expect(isSafeHref('/panes/1')).toBe(false);
    expect(isSafeHref('')).toBe(false);
  });
});

describe('renderMarkdown -- the edges that break naive parsers', () => {
  it('leaves markup inside inline code alone', () => {
    const el = draw('`**not bold**`');
    expect(el.querySelector('strong')).toBeNull();
    expect(el.querySelector('code')?.textContent).toBe('**not bold**');
  });

  it('leaves markup inside a fence alone', () => {
    const el = draw('```\n**not bold** and [not](https://a.example)\n```');
    expect(el.querySelector('strong')).toBeNull();
    expect(el.querySelector('a')).toBeNull();
  });

  it('does not italicise intraword underscores', () => {
    const el = draw('the snake_case_name stays');
    expect(el.querySelector('em')).toBeNull();
    expect(el.textContent).toBe('the snake_case_name stays');
  });

  it('does not italicise spaced asterisks', () => {
    const el = draw('2 * 3 * 4');
    expect(el.querySelector('em')).toBeNull();
    expect(el.textContent).toBe('2 * 3 * 4');
  });

  it('prefers bold over italic for a double delimiter', () => {
    const el = draw('**both**');
    expect(el.querySelector('strong')?.textContent).toBe('both');
  });

  it('keeps an unterminated fence as a code block in progress (streaming)', () => {
    const el = draw('here:\n\n```py\nprint("half a fen');
    expect(el.querySelector('pre code')?.textContent).toBe('print("half a fen');
  });

  it('keeps an unterminated bold literal until its partner arrives', () => {
    expect(draw('half a **bol').querySelector('strong')).toBeNull();
    expect(draw('half a **bol').textContent).toBe('half a **bol');
  });

  it('preserves soft line breaks inside a paragraph', () => {
    const el = draw('line one\nline two');
    expect(el.querySelectorAll('p')).toHaveLength(1);
    expect(el.querySelector('p')?.textContent).toBe('line one\nline two');
  });

  it('renders plain prose as one paragraph and nothing else', () => {
    const el = draw('just a sentence.');
    expect(el.querySelectorAll('p')).toHaveLength(1);
    expect(el.querySelector('p')?.textContent).toBe('just a sentence.');
  });

  it('renders empty text as nothing', () => {
    expect(draw('').textContent).toBe('');
  });
});

describe('renderMarkdown -- precedence between inline rules', () => {
  it('lets bold span a code span it opened before', () => {
    const el = draw('**a `b` c**');
    expect(el.querySelector('strong')).not.toBeNull();
    expect(el.querySelector('strong code')?.textContent).toBe('b');
    expect(el.textContent).toBe('a b c');
  });

  it('lets a code span that opened first swallow bold delimiters', () => {
    const el = draw('`**a**`');
    expect(el.querySelector('strong')).toBeNull();
    expect(el.querySelector('code')?.textContent).toBe('**a**');
  });

  it('formats inside link text', () => {
    const el = draw('[**bold link**](https://example.com)');
    expect(el.querySelector('a strong')?.textContent).toBe('bold link');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });

  it('handles italic and bold in the same line, in order', () => {
    const el = draw('*i* then **b**');
    expect(el.querySelector('em')?.textContent).toBe('i');
    expect(el.querySelector('strong')?.textContent).toBe('b');
    expect(el.textContent).toBe('i then b');
  });
});
