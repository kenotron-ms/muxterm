/**
 * The spoken exit -- a conversational proof.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A UNIT TEST
 *
 * Whether the voice session asks to leave once or three times is not decided
 * by any branch in this repository. It is decided by a model reading
 * internal/voice's Instructions() and choosing when to call end_voice_session.
 * You cannot prove that by reading the code, and an AST walk over the prompt
 * proves only that certain sentences are present -- never that the model
 * behaves. The only evidence that means anything is a CONVERSATION: real
 * speech in, real turns back, and the tool call landing where it should.
 *
 * So this harness holds a scripted human side of three conversations, speaks
 * them at the real model through the real session configuration, and records
 * every turn that comes back.
 *
 *   1. yes        -- "I think I'm done here" / "Yes" -> end_voice_session must
 *                    fire in the VERY NEXT turn. Not after a restatement, not
 *                    after a second check. Turns in between are counted.
 *   2. no         -- "No, not yet" -> the subject is dropped, and does not
 *                    come back on later, unrelated turns.
 *   3. done-with  -- "I'm done with that file" and friends -> never asks about
 *                    leaving at all. A hair-trigger exit is a worse bug than a
 *                    stubborn one, so this scenario pointedly piles four
 *                    finished tasks on top of each other.
 *
 * WHAT MAKES IT HONEST
 *
 * - The instructions and the tool list are read out of internal/voice at run
 *   time (see sessionspec/), never pasted here. The harness cannot drift from
 *   the source it is testing.
 * - The human side is SPOKEN: each line is synthesized to PCM16 by the same
 *   endpoint and fed in as input audio, so the model hears the phrase rather
 *   than reading it. What it heard is captured and printed.
 * - The model side is a real audio response, and the transcript printed is the
 *   transcript of the audio it actually spoke.
 * - end_voice_session is answered with the byte-exact tool result from
 *   internal/voice/endsession.go, so the turn after the hang-up is the turn
 *   production would produce.
 *
 * WHAT IT DOES NOT COVER
 *
 * Turn segmentation. Production uses server VAD to decide when the user has
 * stopped talking; this commits each utterance explicitly, so a turn boundary
 * here is a harness decision rather than a VAD decision. Everything under test
 * -- what the model says, whether it asks twice, when the tool fires -- is
 * downstream of that boundary and unaffected by who drew it. The full audio
 * path with real VAD, WebRTC and a browser is run.mjs; this is the multi-turn
 * conversation that one cannot have, because a fake microphone plays one file
 * once.
 *
 * There is no muxterm server and no chief of staff in this run: the four
 * working tools are answered with short canned results, because the subject
 * here is the conversation, not the bridge. run.mjs proves the bridge.
 *
 * USAGE
 *
 *   npm install
 *   node exit-conversation.mjs                 # all three
 *   node exit-conversation.mjs --only=yes      # one of yes|no|done-with
 *   node exit-conversation.mjs --json=out.json # machine-readable record
 */

import WebSocket from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize } from './synthesize.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const RATE = 24000;

const ARGS = process.argv.slice(2);
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) ?? '').slice(7) || null;
const JSON_OUT = (ARGS.find((a) => a.startsWith('--json=')) ?? '').slice(7) || null;
const TRACE = ARGS.includes('--trace');

const ENDPOINT =
  process.env.VOICE_EXIT_ENDPOINT ??
  readKeysEnv('OPENAI_BASE_URL') ??
  'https://amplifier-model-hosting.openai.azure.com/openai/v1';

// The model REAL USERS TALK TO, read from the installed config, because a
// prompt that behaves on the big model and rambles on the small one is a
// prompt that is broken for everybody who did not change the default.
const MODEL = process.env.VOICE_EXIT_MODEL ?? readConfigModel() ?? 'gpt-realtime-2.1-mini';
const VOICE = process.env.VOICE_EXIT_VOICE ?? 'marin';

// ── the three conversations ──────────────────────────────────────────────
//
// `expect` runs against the turn the model produced in reply to `say`.
// Everything it can check is checked mechanically; the transcript is printed
// either way, because the transcript is the evidence and the assertions are
// only there to stop a green run from being a tired reading of a red one.

const SCENARIOS = [
  {
    id: 'yes',
    title: 'a yes hangs up, in the same turn, with no second question',
    steps: [
      {
        say: "Actually, I think I'm done here.",
        expect: (t, s) => {
          if (t.calls.length) return `asked for no confirmation at all -- called ${t.calls[0].name} straight off a bare "I'm done"`;
          if (!t.spoken.some((x) => x.includes('?'))) return 'did not ask anything; the one confirmation is missing';
          if (countQuestions(t.spoken.join(' ')) > 1) return `asked ${countQuestions(t.spoken.join(' '))} questions in one turn`;
          s.askedAt = t.index;
          return null;
        },
      },
      {
        say: 'Yes.',
        expect: (t, s) => {
          const end = t.calls.find((c) => c.name === 'end_voice_session');
          if (!end) {
            return (
              'end_voice_session did NOT fire on the turn after the yes. ' +
              `The model said: "${t.spoken.join(' ')}"` +
              (countQuestions(t.spoken.join(' ')) ? ' -- and asked again instead.' : '')
            );
          }
          const between = t.index - s.askedAt - 1;
          if (between > 0) return `${between} model turn(s) stood between the yes and the hang-up`;
          const asked = t.spoken.filter((x) => x.includes('?'));
          if (asked.length) return `re-asked while hanging up: "${asked.join(' ')}"`;
          s.turnsBetween = between;
          s.farewell = end.args?.farewell ?? '';
          return null;
        },
      },
    ],
  },

  {
    id: 'no',
    title: 'a no is dropped, and does not come back on later turns',
    steps: [
      {
        say: "I think I'm done here.",
        expect: (t, s) => {
          if (t.calls.length) return `called ${t.calls[0].name} without asking`;
          if (!t.spoken.some((x) => x.includes('?'))) return 'did not ask the one confirmation';
          s.askedAt = t.index;
          return null;
        },
      },
      {
        say: "No, not yet. Let's keep going.",
        expect: (t) => {
          if (t.calls.some((c) => c.name === 'end_voice_session')) return 'hung up on a NO';
          const offer = standingOffer(t.spoken.join(' '));
          if (offer) return `left the exit on the table: "${offer}"`;
          return null;
        },
      },
      {
        say: 'What was the name of that command for watching a file as it grows?',
        toolAnswer: 'tail. Use tail -f to watch it as it grows.',
        expect: (t) => reRaised(t),
      },
      {
        say: 'Right, tail. And how do I make it follow a file that gets rotated?',
        toolAnswer: 'Use tail -F. It follows the NAME, so it reopens the file after a rotation.',
        expect: (t) => reRaised(t),
      },
      {
        say: 'Good. Anything else I should know about it?',
        toolAnswer: 'Only that -F polls, so a very chatty log costs a little CPU.',
        expect: (t) => reRaised(t),
      },
    ],
  },

  {
    id: 'done-with',
    title: 'four finished tasks in a row is a productive session, not a hint',
    steps: [
      {
        say: 'Can you take a look at the notes file in my home directory and tell me how long it is?',
        toolAnswer: 'notes.md is 214 lines long.',
        expect: () => null,
      },
      {
        say: "Great, I'm done with that file.",
        expect: (t) => notAnExitQuestion(t, "I'm done with that file"),
      },
      {
        say: "I've finished the refactor too. That's done.",
        expect: (t) => notAnExitQuestion(t, "that's done"),
      },
      {
        say: 'All done there.',
        expect: (t) => notAnExitQuestion(t, 'all done there'),
      },
      {
        say: "Yep, finished with it. What's the largest file in that directory?",
        toolAnswer: 'The largest is archive.tar.gz, 1.2 gigabytes.',
        expect: (t) => notAnExitQuestion(t, 'finished with it'),
      },
    ],
  },
];

// ── checks ───────────────────────────────────────────────────────────────

const countQuestions = (s) => (s.match(/\?/g) ?? []).length;

/**
 * A sentence that leaves the door open after a no.
 *
 * The instructions forbid exactly this: "just say the word and I'll close it
 * out" is a standing offer to leave, which turns one declined question into a
 * permanent one. Deliberately narrow -- it must mention BOTH leaving and an
 * invitation -- so that "I'm staying" does not trip it.
 */
function standingOffer(text) {
  const t = text.toLowerCase();
  const leaving = /(end|ending|close|closing|hang up|hanging up|wrap up|stop the (call|session)|voice (session|mode)|sign off)/;
  const invite = /(just say|say the word|whenever you|let me know|if you (change|want|ever|decide)|when you're ready|anytime|any time|later on|holler|shout)/;
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const s = sentence.toLowerCase();
    if (leaving.test(s) && invite.test(s)) return sentence.trim();
  }
  // Also catch it split across a clause boundary within one long sentence.
  if (leaving.test(t) && invite.test(t) && text.split(/(?<=[.!?])\s+/).length === 1) return text.trim();
  return null;
}

/**
 * Did the model bring leaving up again, unprompted?
 *
 * A question mark plus a word about the CALL. Words about the work -- done,
 * finished, that file -- are not in the pattern, which is the distinction the
 * instructions turn on.
 */
function exitQuestion(text) {
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (!sentence.includes('?')) continue;
    if (
      /(end (the |this )?(call|session|voice)|hang up|hanging up|close (the |this )?(call|session|voice)|wrap (this |it )?up|voice (session|mode)|be done with (this|the call)|stop (talking|the call)|sign off|leave)/i.test(
        sentence,
      )
    ) {
      return sentence.trim();
    }
  }
  return null;
}

function reRaised(t) {
  if (t.calls.some((c) => c.name === 'end_voice_session')) return 'hung up on an unrelated turn';
  const q = exitQuestion(t.spoken.join(' '));
  if (q) return `raised leaving again, unprompted: "${q}"`;
  const offer = standingOffer(t.spoken.join(' '));
  if (offer) return `re-offered the exit: "${offer}"`;
  return null;
}

function notAnExitQuestion(t, phrase) {
  if (t.calls.some((c) => c.name === 'end_voice_session')) return `hung up on "${phrase}" -- that names a piece of WORK`;
  const q = exitQuestion(t.spoken.join(' '));
  if (q) return `asked about leaving on "${phrase}": "${q}"`;
  return null;
}

// ── the run ──────────────────────────────────────────────────────────────

const usage = { input: 0, output: 0, inputAudio: 0, outputAudio: 0, responses: 0 };
const speechCache = new Map();
let tmp = null;
let token = null;

main().catch(async (err) => {
  console.log(`\n\x1b[31m\x1b[1mFAILED\x1b[0m ${err?.message ?? err}`);
  if (err?.stack) console.log('\x1b[2m' + err.stack.split('\n').slice(1, 4).join('\n') + '\x1b[0m');
  cleanup();
  process.exit(1);
});

async function main() {
  console.log('\n\x1b[1mthe spoken exit -- a conversational proof\x1b[0m');
  console.log(`\x1b[2mendpoint ${ENDPOINT}\n model    ${MODEL}\n voice    ${VOICE}\x1b[0m`);

  token = await entraToken();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muxterm-voice-exit-'));

  // The instructions under test, straight out of the package under test.
  const { stdout } = await execFileAsync('go', ['run', './test/voice-e2e/sessionspec'], {
    cwd: REPO,
    maxBuffer: 8 << 20,
  });
  const spec = JSON.parse(stdout);
  const toolNames = spec.tools.map((t) => t.name);
  console.log(
    `\x1b[2m spec     ${spec.instructions.length} chars of instructions and ${spec.tools.length} tools, ` +
      `read from internal/voice at run time\n          ${toolNames.join(', ')}\x1b[0m\n`,
  );
  if (!toolNames.includes('end_voice_session')) {
    throw new Error('internal/voice offers no end_voice_session; there is nothing to prove');
  }

  const chosen = ONLY ? SCENARIOS.filter((s) => s.id === ONLY) : SCENARIOS;
  if (!chosen.length) throw new Error(`no such scenario: ${ONLY}`);

  const record = [];
  let failures = 0;
  for (const sc of chosen) {
    const result = await runScenario(sc, spec);
    record.push(result);
    failures += result.failures.length;
  }

  console.log('\n\x1b[1m── verdict ─────────────────────────────────────────────────\x1b[0m');
  for (const r of record) {
    const bad = r.failures.length;
    console.log(
      bad
        ? `  \x1b[31mFAIL\x1b[0m  ${r.id.padEnd(10)} ${r.title}\n        ${r.failures.join('\n        ')}`
        : `  \x1b[32mPASS\x1b[0m  ${r.id.padEnd(10)} ${r.title}`,
    );
  }
  const s1 = record.find((r) => r.id === 'yes');
  if (s1 && !s1.failures.length) {
    console.log(
      `\n  \x1b[2mturns between the user's "Yes." and end_voice_session: ${s1.state.turnsBetween}` +
        `\n  farewell spoken while disconnecting: "${s1.state.farewell}"\x1b[0m`,
    );
  }

  console.log(
    `\n\x1b[2mspend: ${usage.responses} model responses \u00b7 ` +
      `in ${usage.input} tokens (${usage.inputAudio} audio) \u00b7 ` +
      `out ${usage.output} tokens (${usage.outputAudio} audio)\x1b[0m`,
  );

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ endpoint: ENDPOINT, model: MODEL, usage, record }, null, 2));
    console.log(`\x1b[2mrecord written to ${JSON_OUT}\x1b[0m`);
  }

  cleanup();
  console.log(
    failures
      ? `\n\x1b[31m\x1b[1mCONVERSATIONAL PROOF FAILED\x1b[0m -- ${failures} broken expectation(s).`
      : `\n\x1b[32m\x1b[1mCONVERSATIONAL PROOF PASSED\x1b[0m -- ${chosen.length} conversation(s) behaved as specified.`,
  );
  process.exit(failures ? 1 : 0);
}

async function runScenario(sc, spec) {
  console.log(`\x1b[1m── ${sc.id}: ${sc.title}\x1b[0m`);
  const ws = await open(spec);
  const state = {};
  const turns = [];
  const failures = [];

  try {
    for (const step of sc.steps) {
      const itemID = await speak(ws, step.say);
      console.log(`  \x1b[36muser\x1b[0m   ${step.say}`);

      let turn = await nextTurn(ws);
      const heard = heardFor(ws, itemID);
      if (heard && normalize(heard) !== normalize(step.say)) {
        console.log(`  \x1b[2mheard   ${heard}\x1b[0m`);
      }

      // A response the platform closed with nothing in it is not the model
      // declining to speak, and scoring it as behaviour would be inventing
      // evidence. Ask once more, loudly, and give up if it happens twice.
      if (turn.incomplete && !turn.spoken.length && !turn.calls.length) {
        console.log(`  \x1b[33mretry\x1b[0m  the endpoint returned an empty turn (${turn.incomplete}); asking again`);
        send(ws, { type: 'response.create' });
        turn = await nextTurn(ws);
      }
      if (!turn.spoken.length && !turn.calls.length) {
        throw new Error(
          `the endpoint produced an empty turn for "${step.say}"` +
            (turn.incomplete ? ` (${turn.incomplete})` : '') +
            ' -- twice. Nothing can be concluded from it, so nothing is claimed.',
        );
      }

      turn.index = turns.length;
      turn.said = step.say;
      turn.heard = heard;
      turns.push(turn);
      print(turn);

      const problem = step.expect(turn, state);
      if (problem) {
        failures.push(`on "${step.say}" -- ${problem}`);
        console.log(`  \x1b[31mbroken\x1b[0m ${problem}`);
      }

      // Answer whatever it called, the way muxterm answers it, and let it
      // speak the result -- the turn AFTER a hang-up is part of the proof.
      for (const call of turn.calls) {
        const [status, instruction] = answerFor(call, step.toolAnswer);
        send(ws, {
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify({ status, instruction }),
          },
        });
        console.log(`  \x1b[35mtool\x1b[0m   ${call.name}(${JSON.stringify(call.args)}) \u2192 answered`);
      }
      if (turn.calls.length) {
        send(ws, { type: 'response.create' });
        const after = await nextTurn(ws);
        after.index = turns.length;
        turns.push(after);
        print(after);
        if (turn.calls.some((c) => c.name === 'end_voice_session')) {
          // Production drops the connection once this has been heard.
          state.goodbye = after.spoken.join(' ');
          break;
        }
      }
    }
  } finally {
    ws.close();
  }

  console.log('');
  return { id: sc.id, title: sc.title, turns, failures, state };
}

function print(turn) {
  for (const line of turn.spoken) console.log(`  \x1b[32mvoice\x1b[0m  ${line}`);
  for (const c of turn.calls) {
    console.log(`  \x1b[33mCALL\x1b[0m   ${c.name} ${JSON.stringify(c.args)}`);
  }
  if (!turn.spoken.length && !turn.calls.length) console.log('  \x1b[2m(said nothing)\x1b[0m');
}

/**
 * How muxterm answers each tool.
 *
 * end_voice_session gets endsession.go's strings, byte for byte, because the
 * turn after the hang-up is part of what is being proven. The four working
 * tools get whatever short answer the step supplied -- there is no chief of
 * staff attached in this run, and a canned answer that does not fit the
 * question leaves the model confabulating in the middle of the evidence.
 */
function answerFor(call, stub) {
  switch (call.name) {
    case 'end_voice_session': {
      const line = (call.args?.farewell ?? '').trim() || 'Goodbye.';
      return [
        'Ending now. Say the goodbye. The connection stays open until the user has heard it, then drops on its own.',
        'Say this out loud to the user now, and nothing else -- no question, no offer, nothing after it: ' + line,
      ];
    }
    case 'cancel_chief_of_staff':
      return ['Stopped.', 'Tell the user it is stopped.'];
    default:
      return [stub ?? 'Done.', 'Tell the user, briefly.'];
  }
}

// ── realtime plumbing ────────────────────────────────────────────────────

async function open(spec) {
  const url = ENDPOINT.replace(/^http/, 'ws') + '/realtime?model=' + encodeURIComponent(MODEL);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  // Every event is KEPT, and a cursor walks it. A queue that consumed events
  // would make the side-channels -- input transcription above all -- race
  // whatever happened to be waiting at the time.
  ws.events = [];
  ws.cursor = 0;
  ws.onEvent = null;
  ws.on('message', (data) => {
    let ev;
    try {
      ev = JSON.parse(data.toString());
    } catch {
      return;
    }
    ws.events.push(ev);
    if (TRACE) {
      const loud = ev.type === 'error' || ev.type === 'response.done' || ev.type.startsWith('session.');
      console.log(`  \x1b[2m<< ${ev.type}${loud ? ' ' + JSON.stringify(ev).slice(0, 900) : ''}\x1b[0m`);
    }
    ws.onEvent?.();
  });

  await waitFor(ws, (e) => e.type === 'session.created', 30_000);
  send(ws, {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: spec.instructions,
      tools: spec.tools,
      tool_choice: 'auto',
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: RATE },
          transcription: { model: 'whisper-1' },
          // Turns are committed explicitly here, so that a scripted line is
          // one turn and the transcript reads as a conversation rather than
          // as whatever VAD happened to slice.
          turn_detection: null,
        },
        output: { format: { type: 'audio/pcm', rate: RATE }, voice: VOICE },
      },
    },
  });
  await waitFor(ws, (e) => e.type === 'session.updated', 30_000);
  return ws;
}

/**
 * Say a line out loud into the session.
 *
 * The wait for `input_audio_buffer.committed` is LOAD-BEARING, and its
 * absence is the subtlest way to get a transcript that lies. commit is
 * asynchronous: a response.create sent straight after it races the item into
 * the conversation, and the model answers a conversation that does not yet
 * contain the utterance. What that produces is not an error -- it is an empty
 * first turn and every later answer shifted one turn late, which reads
 * exactly like a model ignoring the user and then asking a question nobody
 * prompted. The bug looks like the feature failing; it is the harness
 * talking over itself.
 */
async function speak(ws, text) {
  const pcm = await speech(text);
  for (let i = 0; i < pcm.length; i += 32768) {
    send(ws, { type: 'input_audio_buffer.append', audio: pcm.subarray(i, i + 32768).toString('base64') });
  }
  send(ws, { type: 'input_audio_buffer.commit' });
  const committed = await waitFor(ws, (e) => e.type === 'input_audio_buffer.committed', 30_000);

  // And wait to be HEARD, not merely to have been committed. Transcription
  // of the utterance runs alongside the model's own reasoning, and asking
  // for a response before it lands gives the endpoint a conversation whose
  // last item is still being written -- which comes back as an empty turn
  // the content filter closed, rather than as anything the user would see.
  await waitFor(
    ws,
    (e) => e.type === 'conversation.item.input_audio_transcription.completed' && e.item_id === committed.item_id,
    45_000,
  ).catch(() => null);

  send(ws, { type: 'response.create' });
  return committed.item_id ?? null;
}

/**
 * What the model actually heard for an utterance, if the transcriber has
 * caught up. Scanned out of the whole event log rather than waited for: the
 * transcription is a side-channel that arrives on its own schedule, and
 * blocking a turn on it would add a stall to every line for a nicety.
 */
function heardFor(ws, itemId) {
  const t = ws.events.find(
    (e) => e.type === 'conversation.item.input_audio_transcription.completed' && (!itemId || e.item_id === itemId),
  );
  return t?.transcript?.trim() ?? null;
}

/** Synthesized speech for a line, PCM16 at 24 kHz, cached across scenarios. */
async function speech(text) {
  if (speechCache.has(text)) return speechCache.get(text);
  const out = path.join(tmp, `utt-${speechCache.size}.wav`);
  // No padding: with manual commit there is no VAD to satisfy, and silence
  // is billed like anything else.
  await synthesize({ endpoint: ENDPOINT, model: MODEL, token, text, out, leadMs: 0, tailMs: 200 });
  const pcm = fs.readFileSync(out).subarray(44); // strip the WAV header
  speechCache.set(text, pcm);
  return pcm;
}

/** Everything the model produced for one response, in order. */
async function nextTurn(ws) {
  const done = await waitFor(
    ws,
    (e) => e.type === 'response.done' || e.type === 'response.failed' || e.type === 'error',
    180_000,
  );
  if (done.type === 'error') throw new Error('realtime: ' + JSON.stringify(done.error ?? done).slice(0, 400));
  const r = done.response ?? {};
  if (r.status === 'failed') {
    throw new Error('the response failed: ' + JSON.stringify(r.status_details ?? {}).slice(0, 400));
  }
  const incomplete = r.status === 'incomplete' ? (r.status_details?.reason ?? 'incomplete') : null;

  usage.responses += 1;
  const u = r.usage ?? {};
  usage.input += u.input_tokens ?? 0;
  usage.output += u.output_tokens ?? 0;
  usage.inputAudio += u.input_token_details?.audio_tokens ?? 0;
  usage.outputAudio += u.output_token_details?.audio_tokens ?? 0;

  const spoken = [];
  const calls = [];
  for (const item of r.output ?? []) {
    if (item.type === 'function_call') {
      let args = {};
      try {
        args = JSON.parse(item.arguments || '{}');
      } catch {
        args = { _unparsed: item.arguments };
      }
      calls.push({ name: item.name, call_id: item.call_id, args });
    } else if (item.type === 'message') {
      for (const c of item.content ?? []) {
        const text = c.transcript ?? c.text;
        if (text?.trim()) spoken.push(text.trim());
      }
    }
  }
  return { spoken, calls, incomplete };
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

/**
 * Wait for the next event matching `pred`, from where the last match left off.
 *
 * A failed wait must leave the cursor ALONE. An earlier version consumed
 * every event it looked at, so one optional wait that timed out swallowed the
 * whole turn behind it and every later wait hung -- the classic way a
 * best-effort read poisons the sequence it was trying not to disturb.
 */
function waitFor(ws, pred, timeoutMs) {
  const from = ws.cursor;
  const scan = () => {
    for (let i = from; i < ws.events.length; i++) {
      if (pred(ws.events[i])) {
        ws.cursor = Math.max(ws.cursor, i + 1);
        return ws.events[i];
      }
    }
    return null;
  };
  const here = scan();
  if (here) return Promise.resolve(here);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.onEvent = null;
      reject(new Error(`timed out after ${timeoutMs}ms waiting for the model`));
    }, timeoutMs);
    ws.onEvent = () => {
      const found = scan();
      if (!found) return;
      clearTimeout(timer);
      ws.onEvent = null;
      resolve(found);
    };
  });
}

// ── odds and ends ────────────────────────────────────────────────────────

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function readKeysEnv(key) {
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.config/muxterm/keys.env'), 'utf8');
    const m = txt.match(new RegExp('^' + key + '=(.*)$', 'm'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function readConfigModel() {
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.config/muxterm/config.toml'), 'utf8');
    const voice = txt.split(/^\s*\[voice\]\s*$/m)[1];
    const m = voice?.split(/^\s*\[/m)[0]?.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function entraToken() {
  const { stdout } = await execFileAsync('az', [
    'account',
    'get-access-token',
    '--scope',
    'https://ai.azure.com/.default',
    '--query',
    'accessToken',
    '-o',
    'tsv',
  ]);
  const t = stdout.trim();
  if (!t) throw new Error('az returned no token -- run `az login`');
  return t;
}

function cleanup() {
  if (tmp) {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\x1b[2mteardown: ${tmp} removed\x1b[0m`);
  }
}
