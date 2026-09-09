/**
 * applet-artifact.ts -- the Viewer. One file, shown the way a recipient of a
 * published link would see it.
 *
 * ┌─ THE ONE IDEA ───────────────────────────────────────────────────────────┐
 * │                                                                          │
 * │   THIS IS THE LOCAL PREVIEW OF THE PUBLISHED VIEW.                       │
 * │                                                                          │
 * │   Publishing without it is a guess you confirm afterwards: you publish,   │
 * │   open the link, and find out how it came out. That only stops being     │
 * │   true if the two agree -- so this applet does not RESEMBLE the public    │
 * │   page, it is built from the same parts:                                  │
 * │                                                                          │
 * │     the CLASSIFIER   publicationKindFor() server-side, on the wire as    │
 * │                      `kind` -- not a second table in the frontend        │
 * │     the RENDERER     parseMarkdown() + renderSegments(), the same two    │
 * │                      calls web/src/public-doc.ts makes, in that order    │
 * │     the STYLESHEET   publicDocCSS itself, fetched from the server        │
 * │     the BOUND        publicationMaxBytes, on the wire as `maxBytes`      │
 * │                                                                          │
 * │   Nothing above is a copy. A change to any of them lands in both views    │
 * │   on the commit that makes it.                                           │
 * │                                                                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ⛔ HTML AND SVG DO NOT RENDER HERE, AND THE ASYMMETRY IS WHY.
 *
 * publish.go refuses them because they carry script. That refusal is even more
 * necessary locally: /p/{id} serves an anonymous stranger, while THIS runs
 * inside muxterm's own authenticated origin, holding the user's session, next
 * to a live terminal multiplexer. A hostile .html rendered inline here would
 * execute with access to exactly the origin the user is logged into -- the
 * strictly worse half of the trade.
 *
 * A sandboxed iframe was the obvious alternative and was rejected on the same
 * grounds it would have been chosen for: it renders MORE actively than the
 * public route does, so the preview would stop predicting the published page
 * for precisely the file types where being wrong is most expensive. There is
 * no iframe on this path, sandboxed or otherwise, and no innerHTML: a file that
 * does not render is named, described, and offered as a download.
 *
 * PDF lands in the same place, for the same two reasons: the public route
 * downloads it, and rendering one means handing bytes to a plug-in in this
 * origin. See the PR body for what an inline PDF would cost.
 *
 * NO CARDS, NO SIDE BORDERS. State is carried by a typographic marker in a
 * fixed gutter, by ink, and by weight -- the idiom the Files applet's .pmark
 * rules already use, legible in both palettes and never colour alone.
 */

import { LitElement, html, css, nothing, render, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { Eye } from 'lucide';
import { registerApplet, type AppletElement, type AppletNavigateDetail } from '../../lib/applet-registry.js';
import { appletControlStyles } from '../../lib/applet-controls.js';
import { appletEmpty, appletError, appletStateStyles } from '../mux-applets.js';
import {
  artifactRawURL,
  fetchArtifact,
  fetchDocCSS,
  type Artifact,
} from '../../lib/artifact-api.js';
import { onArtifactOpen } from '../../lib/artifact-open.js';
import { parseMarkdown } from '../../lib/markdown-stream.js';
import { renderSegments } from '../../lib/markdown-view.js';

/** `path:/abs/file` is the target vocabulary the applet contract already uses. */
const TARGET_PREFIX = 'path:';

/** Bytes as a person reads them. */
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** A path split for display: the directory quiet, the filename loud. */
function splitPath(p: string): { dir: string; base: string } {
  const cut = p.lastIndexOf('/');
  if (cut < 0) return { dir: '', base: p };
  return { dir: p.slice(0, cut + 1), base: p.slice(cut + 1) };
}

/**
 * What a refused file is refused FOR, in the user's words rather than the
 * classifier's. Every branch says what happens instead, because "cannot be
 * shown" with no next step is a dead end.
 */
function refusalFor(a: Artifact): { mark: string; head: string; why: string } {
  if (a.tooLarge) {
    return {
      mark: '\u2013',
      head: 'Too large to show',
      why:
        `This file is ${humanSize(a.size)}. The viewer reads at most ` +
        `${humanSize(a.maxBytes)} -- the same bound a published link serves under -- so its ` +
        `contents were never read. Downloading it does not go through that bound.`,
    };
  }
  if (a.binary) {
    return {
      mark: '\u2013',
      head: 'Not text',
      why:
        'This file has an extension that usually means text, but its bytes are not. ' +
        'Rendering it would produce a screen of replacement characters rather than anything readable.',
    };
  }
  return {
    mark: '\u2013',
    head: 'Not shown here',
    why:
      'HTML, SVG, PDF and unrecognised types are never rendered inside muxterm, because they can carry ' +
      'script and this page holds your session. A published link refuses them for the same reason and ' +
      'serves them as a download. This does the same.',
  };
}

@customElement('applet-artifact')
export class AppletArtifact extends LitElement implements AppletElement {
  /** Host contract: an inactive applet goes quiet. */
  @property({ type: Boolean }) active = false;

  @property({ type: Boolean }) narrow = false;

  /** Host contract: `path:/abs/file`. Consumed and cleared back to null. */
  @property({ attribute: false }) target: string | null = null;

  @state() private _artifact: Artifact | null = null;
  @state() private _error = '';
  @state() private _loading = false;

  /** What is being shown. Survives a trip to another tab and back. */
  private _path = '';

  /** In-flight read, aborted when the applet goes inactive or moves on. */
  private _abort: AbortController | null = null;

  private _unsubOpen: (() => void) | null = null;

  /**
   * The published-document stylesheet, adopted into THIS shadow root.
   *
   * Adopted at runtime rather than declared in `static styles` because its
   * bytes come from the server -- that is the whole agreement argument (see
   * lib/artifact-api.ts). Adopted once per element; the fetch itself is cached
   * module-side, so a second applet instance costs no second request.
   */
  private _docSheet: CSSStyleSheet | null = null;

  static styles = [
    appletStateStyles,
    appletControlStyles,
    css`
      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }

      :host {
        display: block;
        min-width: 0;
      }

      .body {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        padding: var(--s-4) var(--s-4) 0;
      }

      /* -- THE HEADING -----------------------------------------------------
         What you are looking at, and the facts about it. Directory in quiet
         ink, filename in loud ink -- the same split the Files applet uses on
         a published row, so a path reads the same way in both places. */
      .head {
        flex: none;
        min-width: 0;
        padding: 0 var(--s-1) var(--s-3);
      }
      .name {
        display: block;
        font-family: var(--mono);
        font-size: var(--t-ui);
        line-height: 1.35;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .name .dir {
        color: var(--ink-3);
      }
      .name .base {
        color: var(--ink-1);
        font-weight: 600;
      }
      /* kind · size · when. Facts, in one quiet line, never a badge. */
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0 var(--s-3);
        margin-top: var(--s-1);
        font-family: var(--mono);
        font-size: var(--t-meta);
        line-height: 1.5;
        color: var(--ink-3);
      }
      .meta .sep {
        color: var(--edge);
      }
      /* The one fact that is a claim rather than a measurement: this is what
         a recipient would see. Accent ink, no chrome. */
      .meta .asseen {
        color: var(--chrome-accent);
      }

      /* -- THE DOCUMENT ----------------------------------------------------
         .doc-body and .doc are the PUBLISHED page's own classes, styled by
         the published page's own stylesheet, fetched from the server. The
         only rules here are the ones that make it a panel in an applet
         instead of a whole browser window: it scrolls, and its page padding
         shrinks to something sane in a column this narrow. */
      .doc-body {
        flex: 1;
        min-height: 0;
        overflow: auto;
        border-top: 1px solid var(--edge);
        padding: var(--s-6) var(--s-5) var(--s-7);
      }
      /* The public page centres in 46rem of browser window. In an applet
         column that measure is already the whole width, so the auto margins
         have nothing to do -- but they stay correct if the column is wide. */

      /* -- PLAIN TEXT ------------------------------------------------------
         Characters, monospace, NOT markdown. A .txt that happens to start
         with "# " is a file about shell comments, not a heading. */
      .text {
        flex: 1;
        min-height: 0;
        overflow: auto;
        margin: 0;
        border-top: 1px solid var(--edge);
        padding: var(--s-5) var(--s-4) var(--s-7);
        font-family: var(--mono);
        font-size: 12px;
        line-height: 1.55;
        color: var(--ink-1);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        tab-size: 4;
      }

      /* -- IMAGE -----------------------------------------------------------
         On the page's own background, at its natural size up to the width of
         the column. No frame: a frame is chrome pretending to be information. */
      .image {
        flex: 1;
        min-height: 0;
        overflow: auto;
        border-top: 1px solid var(--edge);
        padding: var(--s-5) var(--s-4) var(--s-7);
      }
      .image img {
        display: block;
        max-width: 100%;
        height: auto;
      }

      /* -- REFUSAL ---------------------------------------------------------
         ⛔ NO CARD, NO SIDE BORDER. A typographic marker in a FIXED GUTTER,
         a heading in ink and weight, and the reason in words. The gutter is
         what makes it read as a marked block at any width -- it does not
         reflow into the prose when the column is narrow, and it carries no
         meaning that colour alone is carrying. */
      .refuse {
        flex: 1;
        min-height: 0;
        overflow: auto;
        border-top: 1px solid var(--edge);
        display: grid;
        grid-template-columns: 1.25rem 1fr;
        align-content: start;
        gap: 0 var(--s-2);
        padding: var(--s-6) var(--s-4) var(--s-7);
      }
      .refuse .mark {
        font-family: var(--mono);
        font-size: var(--t-ui);
        line-height: 1.5;
        color: var(--ink-3);
        text-align: center;
      }
      .refuse .head2 {
        font-size: var(--t-ui);
        font-weight: 600;
        line-height: 1.5;
        color: var(--ink-1);
      }
      .refuse .why {
        grid-column: 2;
        max-width: 46ch;
        margin-top: var(--s-2);
        font-size: 12px;
        line-height: var(--lh-body);
        color: var(--ink-2);
      }
      .refuse .act {
        grid-column: 2;
        margin-top: var(--s-4);
      }
      /* A link that behaves like this applet's other controls: text, ink,
         no slab. */
      .dl {
        font-family: var(--mono);
        font-size: 10.5px;
        font-weight: 500;
        letter-spacing: 0.02em;
        color: var(--chrome-accent);
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .dl:focus-visible {
        outline: 2px solid var(--chrome-accent);
        outline-offset: 2px;
      }

      .hint {
        padding: var(--s-6) var(--s-4);
        font-size: 13px;
        color: var(--ink-3);
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    // The programmatic entrance. Subscribed here rather than in the host
    // because this element is mounted for the host's whole lifetime, so it is
    // always listening -- see lib/artifact-open.ts for why that matters.
    this._unsubOpen = onArtifactOpen(this._onOpenRequest);
    void this._adoptDocSheet();
  }

  override disconnectedCallback(): void {
    this._unsubOpen?.();
    this._unsubOpen = null;
    this._abort?.abort();
    this._abort = null;
    super.disconnectedCallback();
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('target') && this.target !== null) {
      const t = this.target;
      // Consumed and cleared, per the contract.
      this.target = null;
      if (t.startsWith(TARGET_PREFIX)) {
        const p = t.slice(TARGET_PREFIX.length).trim();
        if (p !== '') this._open(p);
      }
    }
    if (changed.has('active')) this._sync();
    // The markdown body is rendered imperatively into its container AFTER
    // lit has put that container in the DOM -- see _renderDoc.
    this._paintDoc();
  }

  /**
   * The inactive rule. An applet nobody is looking at holds no in-flight
   * request; what it already read stays, so coming back is instant.
   */
  private _sync(): void {
    if (!this.active) {
      this._abort?.abort();
      this._abort = null;
      this._loading = false;
    }
  }

  /**
   * A request arrived from outside the DOM -- the server pushed one, because
   * somebody asked the chief of staff to show them a file.
   *
   * It asks the HOST to show this applet, the ordinary way, by firing
   * `applet-navigate` from itself. The event bubbles up through the host's
   * existing listener; nothing in <mux-applets> knows this entrance exists.
   */
  private _onOpenRequest = (path: string): void => {
    this.dispatchEvent(
      new CustomEvent<AppletNavigateDetail>('applet-navigate', {
        detail: { applet: 'artifact', target: `${TARGET_PREFIX}${path}` },
        bubbles: true,
        composed: true,
      }),
    );
  };

  /** Show a file. Public so a caller holding the element can drive it. */
  private _open(path: string): void {
    this._path = path;
    void this._load(path);
  }

  private async _load(path: string): Promise<void> {
    this._abort?.abort();
    const ac = new AbortController();
    this._abort = ac;
    this._loading = true;
    this._error = '';
    try {
      const a = await fetchArtifact(path, ac.signal);
      // A slower earlier read must not overwrite a newer one.
      if (ac.signal.aborted || this._path !== path) return;
      this._artifact = a;
      this._error = '';
    } catch (err) {
      if (ac.signal.aborted) return;
      this._artifact = null;
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      if (this._abort === ac) this._abort = null;
      this._loading = false;
    }
  }

  private _retry = (): void => {
    if (this._path !== '') void this._load(this._path);
  };

  private _reread = (): void => {
    this._retry();
  };

  /**
   * Adopt the published-document stylesheet into this shadow root.
   *
   * A failure is not fatal and is not reported: the document still renders,
   * in the app's inherited type rather than the published page's. Saying
   * "could not load a stylesheet" over a perfectly readable document would be
   * noise about the wrong thing.
   */
  private async _adoptDocSheet(): Promise<void> {
    if (this._docSheet !== null) return;
    try {
      const text = await fetchDocCSS();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      this._docSheet = sheet;
      const root = this.renderRoot as ShadowRoot;
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      this.requestUpdate();
    } catch {
      /* the document is still readable without it */
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  override render(): TemplateResult {
    return html`
      <div class="body">
        ${this._renderControls()}
        ${this._renderHead()}
        ${this._renderContent()}
      </div>
    `;
  }

  /**
   * THIS APPLET'S OWN CONTROLS, in this applet's own body -- not in the tab
   * strip. The host has no slot for them and must not grow one; see the
   * contract at the top of lib/applet-registry.ts.
   *
   * They are ACTIONS rather than filters, which is why they are plain .ctl
   * buttons and none of them is ever `on`: there is one document and no view
   * of it to choose between.
   */
  private _renderControls(): TemplateResult {
    const a = this._artifact;
    const has = a !== null;
    return html`
      <div class="controls" role="group" aria-label="This file">
        <button
          type="button"
          class="ctl"
          ?disabled="${!has}"
          title="Read this file from disk again. It may have changed."
          @click="${this._reread}"
        >re-read</button>
        <button
          type="button"
          class="ctl"
          ?disabled="${!has}"
          title="Show the directory this file is in, in the Files applet"
          @click="${this._showInFiles}"
        >in files</button>
        ${has
          ? html`<a
              class="ctl"
              href="${artifactRawURL(a.path)}"
              download="${a.name}"
              title="Save this file. Nothing is rendered on the way."
            >download</a>`
          : html`<button type="button" class="ctl" disabled>download</button>`}
        ${this._loading ? html`<span class="ctl-why">reading&hellip;</span>` : nothing}
      </div>
      <div class="controls-rule"></div>
    `;
  }

  /** Back to the directory. Same `applet-navigate`, other direction. */
  private _showInFiles = (): void => {
    const a = this._artifact;
    if (!a) return;
    const { dir } = splitPath(a.path);
    if (dir === '') return;
    this.dispatchEvent(
      new CustomEvent<AppletNavigateDetail>('applet-navigate', {
        // Trailing slash trimmed: the Files applet navigates to a directory.
        detail: { applet: 'files', target: `${TARGET_PREFIX}${dir.replace(/\/$/, '')}` },
        bubbles: true,
        composed: true,
      }),
    );
  };

  private _renderHead(): TemplateResult | typeof nothing {
    const a = this._artifact;
    if (!a) return nothing;
    const { dir, base } = splitPath(a.path);
    const when = a.modified > 0 ? new Date(a.modified * 1000).toLocaleString() : '';
    return html`
      <div class="head">
        <span class="name" title="${a.path}"
          ><span class="dir">${dir}</span><span class="base">${base}</span></span
        >
        <div class="meta">
          <span>${a.kind}</span>
          <span class="sep" aria-hidden="true">·</span>
          <span>${humanSize(a.size)}</span>
          ${when === '' ? nothing : html`<span class="sep" aria-hidden="true">·</span><span>${when}</span>`}
          <span class="sep" aria-hidden="true">·</span>
          <span class="asseen" title="This is the same renderer, stylesheet and size bound a published link serves under."
            >as a recipient sees it</span
          >
        </div>
      </div>
    `;
  }

  private _renderContent(): TemplateResult {
    if (this._error !== '') return appletError(this._error, this._retry);
    if (this._path === '') {
      return appletEmpty('Open a file from the Files tab to see it here, exactly as a published link would show it.');
    }
    const a = this._artifact;
    if (!a) return html`<div class="hint">Reading&hellip;</div>`;

    if (a.tooLarge || a.binary) return this._renderRefusal(a);

    switch (a.kind) {
      case 'markdown':
        return this._renderDoc();
      case 'text':
        return html`<pre class="text">${a.text}</pre>`;
      case 'image':
        return html`<div class="image">
          <img src="${artifactRawURL(a.path)}" alt="${a.name}" />
        </div>`;
      default:
        return this._renderRefusal(a);
    }
  }

  /**
   * The markdown container.
   *
   * .doc-body and .doc are the PUBLISHED page's classes and the fetched
   * stylesheet is the published page's stylesheet, so this markup is the
   * published page's markup. The body is painted into it by _paintDoc.
   */
  private _renderDoc(): TemplateResult {
    return html`<div class="doc-body"><div class="doc" id="doc"></div></div>`;
  }

  /**
   * Paint the document with THE SAME TWO CALLS public-doc.ts makes, in the
   * same order, with the same absent link policy.
   *
   *     render(renderSegments(parseMarkdown(source)), host)
   *
   * The policy argument is deliberately omitted, which is what a SINGLE
   * published file gets: an image draws as its alt text and fetches nothing, a
   * relative link is not clickable. Passing one here would make the preview
   * show links and images that the published single-file page will not, which
   * is the exact class of disagreement this applet exists to remove.
   *
   * Imperative, because lit's `render()` needs a container that is already in
   * the DOM. Called from updated() -- after lit has placed it.
   */
  private _paintDoc(): void {
    const host = this.renderRoot.querySelector<HTMLElement>('#doc');
    if (!host) return;
    const a = this._artifact;
    if (!a || a.kind !== 'markdown' || a.tooLarge || a.binary) return;
    const painted = host.getAttribute('data-src');
    // Repainting an unchanged document on every host update would rebuild the
    // whole DOM under the reader's scroll position.
    if (painted === a.path + '\u0000' + String(a.modified) + '\u0000' + String(a.size)) return;
    host.setAttribute('data-src', a.path + '\u0000' + String(a.modified) + '\u0000' + String(a.size));
    render(renderSegments(parseMarkdown(a.text)), host);
  }

  private _renderRefusal(a: Artifact): TemplateResult {
    const r = refusalFor(a);
    return html`
      <div class="refuse">
        <span class="mark" aria-hidden="true">${r.mark}</span>
        <span class="head2">${r.head}</span>
        <p class="why">${r.why}</p>
        <span class="act">
          <a class="dl" href="${artifactRawURL(a.path)}" download="${a.name}">download ${a.name}</a>
        </span>
      </div>
    `;
  }
}

/**
 * The manifest: a tab, and nothing about what is under it. Ordered after
 * Files, because that is where you come from.
 */
registerApplet({
  id: 'artifact',
  label: 'Viewer',
  icon: Eye,
  element: 'applet-artifact',
  order: 25,
});

declare global {
  interface HTMLElementTagNameMap {
    'applet-artifact': AppletArtifact;
  }
}
