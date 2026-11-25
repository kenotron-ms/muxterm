import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiPath } from '../lib/base-path.js';
import { remoteChatPath } from '../lib/remote-chat-routes.js';
import { chatMeta, elapsed, usageKeys, type MetaEvent } from '../lib/chat-meta.js';

const number = new Intl.NumberFormat();
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const usageLabels = {
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cachedInputTokens: 'Cached input tokens',
};

function duration(value: number) {
  return value > 0 && value < 10 ? '<0.01 s' : `${decimal.format(value / 1000)} s`;
}

@customElement('mux-chat-meta')
export class MuxChatMeta extends LitElement {
  @property() sessionId = '';
  @property() remoteHost = '';
  @state() private metrics?: ReturnType<typeof chatMeta>;
  @state() private loading = false;
  @state() private error = '';
  private request?: AbortController;

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) void this.load();
  }

  override disconnectedCallback() {
    this.request?.abort();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has('sessionId') || changed.has('remoteHost')) {
      this.metrics = undefined;
      void this.load();
    }
  }

  private async load() {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.loading = true;
    this.error = '';
    try {
      const path = apiPath(remoteChatPath(this.remoteHost, `/api/sdk-chats/${encodeURIComponent(this.sessionId)}/history`));
      const pages: MetaEvent[][] = [];
      let before: number | undefined;
      do {
        const params = new URLSearchParams({ view: 'meta' });
        if (before !== undefined) params.set('before', String(before));
        const response = await fetch(`${path}?${params}`, { signal: request.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`History request failed (${response.status}).`);
        const page = await response.json() as { from: number; hasMore: boolean; events: MetaEvent[] };
        if (page.hasMore && (page.from <= 0 || (before !== undefined && page.from >= before))) {
          throw new Error('History cursor did not advance.');
        }
        pages.push(page.events);
        before = page.hasMore ? page.from : undefined;
      } while (before !== undefined);
      if (!request.signal.aborted) this.metrics = chatMeta(pages.reverse().flat());
    } catch (error) {
      if (!request.signal.aborted) this.error = String(error);
    } finally {
      if (!request.signal.aborted) this.loading = false;
    }
  }

  private metric(label: string, value?: string, coverage?: string) {
    return html`<div><dt>${label}</dt><dd>${value ?? html`<span class="muted">Unavailable</span>`}
      ${coverage ? html`<small>${coverage}</small>` : nothing}</dd></div>`;
  }

  private timingSummary(label: string, values: (number | undefined)[]) {
    const observed = values.filter((value): value is number => value !== undefined).sort((a, b) => a - b);
    const count = observed.length;
    const midpoint = Math.floor(count / 2);
    const median = count % 2 ? observed[midpoint] : (observed[midpoint - 1] + observed[midpoint]) / 2;
    return html`<h4>${label} <small>${count} of ${values.length} turns</small></h4>
      <dl>
        ${this.metric('Average', count ? duration(observed.reduce((sum, value) => sum + value, 0) / count) : undefined)}
        ${this.metric('Median', count ? duration(median) : undefined)}
        ${this.metric('Maximum', count ? duration(observed[count - 1]) : undefined)}
      </dl>`;
  }

  protected override render() {
    const turns = this.metrics?.turns ?? [];
    const total = (label: string, values: (number | undefined)[], format: (value: number) => string) => {
      const observed = values.filter((value): value is number => value !== undefined);
      return this.metric(label, observed.length ? format(observed.reduce((sum, value) => sum + value, 0)) : undefined,
        observed.length && observed.length < turns.length ? `${observed.length} of ${turns.length} turns` : undefined);
    };
    const assignedCalls = turns.reduce((sum, turn) => sum + turn.tools.size, 0);
    const calls = assignedCalls + (this.metrics?.orphanTools ?? 0);
    const durations = turns.map(turn => elapsed(turn.started, turn.ended));
    const responseTimes = turns.map(turn => elapsed(turn.started, turn.firstOutput));
    return html`
      <header><h2>Chat statistics</h2>
        <mux-ui-button size="small" variant="quiet" ?disabled=${this.loading} @click=${() => void this.load()}>Refresh</mux-ui-button>
      </header>
      ${this.loading ? html`<p role="status">Reading chat history…</p>` : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.metrics ? html`
        <dl>
          ${this.metric('Recorded turns', number.format(turns.length))}
          ${total('Elapsed turn time', durations, duration)}
          ${this.metric('Tool calls observed', number.format(calls))}
          ${this.metric('Tool calls per recorded turn', turns.length ? decimal.format(assignedCalls / turns.length) : undefined)}
          ${usageKeys.map(key => total(usageLabels[key], turns.map(turn => turn.usage[key]), number.format))}
        </dl>
        <p class="muted">Elapsed time includes tools and waits. The recorded events do not isolate generation time for a tokens-per-second rate.</p>
        ${this.metrics.orphanTools ? html`<p class="muted">${this.metrics.orphanTools} observed tool calls could not be assigned to a turn.</p>` : nothing}
        ${turns.length ? html`
          <details><summary><strong>Timing summary</strong></summary>
            ${this.timingSummary('Elapsed time', durations)}
            ${this.timingSummary('Time to first visible output', responseTimes)}
          </details>
          <h3>Turns</h3>
          ${turns.map((turn, index) => {
            const elapsedTime = elapsed(turn.started, turn.ended);
            const firstOutput = elapsed(turn.started, turn.firstOutput);
            return html`<details><summary><strong>Turn ${index + 1}</strong><span>${turn.outcome ?? 'No recorded end'}</span></summary>
              <dl>
                ${this.metric('Model', turn.model)}
                ${this.metric('Elapsed time', elapsedTime === undefined ? undefined : duration(elapsedTime))}
                ${this.metric('First visible output', firstOutput === undefined ? undefined : duration(firstOutput))}
                ${this.metric('Tool calls observed', number.format(turn.tools.size))}
                ${usageKeys.map(key => this.metric(usageLabels[key], turn.usage[key] === undefined ? undefined : number.format(turn.usage[key])))}
              </dl>
            </details>`;
          }).reverse()}`
          : html`<p>No turn events recorded.</p>`}
      ` : nothing}`;
  }

  static override styles = css`
    :host { display: block; box-sizing: border-box; height: 100%; overflow: auto; padding: var(--ui-space-5); color: var(--ui-text); font: var(--ui-text-sm)/1.5 var(--ui-font-sans); }
    header, summary, dl > div { display: flex; justify-content: space-between; align-items: baseline; gap: var(--ui-space-3); }
    h2, h3, h4 { margin: 0; font-size: var(--ui-text-sm); }
    h4 { margin-top: var(--ui-space-3); }
    h3 { margin-top: var(--ui-space-5); }
    dl { margin: var(--ui-space-3) 0; }
    dl > div { padding: var(--ui-space-2) 0; border-bottom: 1px solid var(--ui-border); }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; text-align: end; font-variant-numeric: tabular-nums; }
    small, .muted, summary span { color: var(--ui-text-muted); }
    small { display: block; }
    details { border-bottom: 1px solid var(--ui-border); }
    summary { display: list-item; padding: var(--ui-space-3) 0; cursor: pointer; }
    summary span { float: inline-end; margin-inline-start: var(--ui-space-3); }
    summary:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  `;
}
