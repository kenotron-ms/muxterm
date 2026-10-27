import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

export type QuestionPrompt = { id:string; header:string; question:string; isOther:boolean; isSecret:boolean; options:{label:string;description:string}[]|null };

/** A compact, accessible answer form for agent questions. Answers leave only
 * through the submit event; the completed view removes every input. */
@customElement('mux-ui-question-form')
export class MuxUIQuestionForm extends LitElement {
  @property({ attribute:false }) questions:QuestionPrompt[] = [];
  @property() agentLabel = 'Agent';
  @property({ type:Boolean }) pending = false;
  @property({ type:Boolean }) answered = false;
  @property() error = '';
  @state() private validationError = '';

  static override styles = css`
    :host { display:block; min-width:0; font-family:var(--ui-font-sans); }
    .card { box-sizing:border-box; padding:var(--ui-space-6); border:1px solid var(--ui-border); border-radius:var(--ui-radius-lg); background:var(--ui-surface-raised); color:var(--ui-text); }
    h3 { margin:0 0 var(--ui-space-5); font-size:var(--ui-text-lg); font-weight:650; }
    fieldset { min-width:0; margin:0 0 var(--ui-space-5); padding:0; border:0; }
    legend { width:100%; margin-bottom:var(--ui-space-3); font-size:var(--ui-text-lg); line-height:1.5; }
    .option { display:flex; align-items:flex-start; gap:var(--ui-space-3); margin:var(--ui-space-2) 0; padding:var(--ui-space-3) var(--ui-space-4); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); cursor:pointer; }
    .option:has(input:checked) { border-color:var(--ui-accent); background:color-mix(in srgb,var(--ui-accent) 7%,var(--ui-surface-raised)); }
    .option input { margin:var(--ui-space-1) 0 0; accent-color:var(--ui-accent); }
    .option small { display:block; margin-top:var(--ui-space-1); color:var(--ui-text-muted); }
    .answer { box-sizing:border-box; width:100%; min-height:var(--ui-control-lg); padding:var(--ui-space-3) var(--ui-space-4); border:1px solid var(--ui-border); border-radius:var(--ui-radius-md); background:var(--ui-surface-base); color:var(--ui-text); font:inherit; }
    .actions { display:flex; align-items:center; justify-content:space-between; gap:var(--ui-space-4); }
    button { min-height:var(--ui-control-sm); padding:0 var(--ui-space-4); border:1px solid var(--ui-accent); border-radius:var(--ui-radius-md); background:var(--ui-accent); color:var(--ui-on-accent); font:600 var(--ui-text-sm) var(--ui-font-sans); cursor:pointer; }
    button:focus-visible,.answer:focus-visible { outline:2px solid var(--ui-focus); outline-offset:2px; }
    button:disabled { opacity:.5; cursor:default; }
    .error { color:var(--ui-danger); font-size:var(--ui-text-sm); }
    .done { color:var(--ui-text-muted); font-size:var(--ui-text-sm); }
  `;

  private submit(event:SubmitEvent) {
    event.preventDefault();
    if (this.answered || this.pending) return;
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const answers:Record<string,string> = {};
    for (const [index, question] of this.questions.entries()) {
      const choice = String(data.get(`q-${index}`) || '');
      const typed = String(data.get(`other-${index}`) || '').trim();
      const answer = choice === '__other__' || !question.options?.length ? typed : choice;
      if (!answer) { this.validationError = `Answer ${question.header || index + 1} to continue.`; return; }
      answers[question.id] = answer;
    }
    this.validationError = '';
    this.dispatchEvent(new CustomEvent('question-submit', { detail:answers, bubbles:true, composed:true }));
  }

  override render() {
    if (this.answered) return html`<section class="card" aria-label="Question from ${this.agentLabel}"><h3>${this.agentLabel} asked</h3>${this.questions.map(question => html`<p>${question.question}</p>`)}<span class="done">Answered</span></section>`;
    const error = this.error || this.validationError;
    return html`<form class="card" aria-label="Question from ${this.agentLabel}" @submit=${this.submit}>
      <h3>${this.agentLabel} asks</h3>
      ${this.questions.map((question,index) => html`<fieldset ?disabled=${this.pending}>
        <legend>${question.header ? html`<strong>${question.header}</strong> · ` : nothing}${question.question}</legend>
        ${question.options?.map(option => html`<label class="option"><input type="radio" name=${`q-${index}`} value=${option.label}><span>${option.label}${option.description ? html`<small>${option.description}</small>` : nothing}</span></label>`)}
        ${question.isOther && question.options?.length ? html`<label class="option"><input type="radio" name=${`q-${index}`} value="__other__"><span>Other answer</span></label>` : nothing}
        ${!question.options?.length || question.isOther ? html`<input class="answer" name=${`other-${index}`} type=${question.isSecret ? 'password' : 'text'} aria-label=${question.options?.length ? `Other answer for ${question.header || question.question}` : question.question} placeholder="Type your answer…" autocomplete="off">` : nothing}
      </fieldset>`)}
      <div class="actions"><span class="error" role=${error ? 'alert' : nothing}>${error}</span><button type="submit" ?disabled=${this.pending}>${this.pending ? 'Sending…' : 'Send answer'}</button></div>
    </form>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'mux-ui-question-form': MuxUIQuestionForm } }
