/**
 * Synthesize the test utterance.
 *
 * The harness needs speech to feed Chromium in place of a microphone, and it
 * cannot depend on a person, a checked-in audio file, or a TTS package being
 * installed on the machine. So it uses the realtime endpoint it is already
 * configured against: open a plain WebSocket session, send text, and keep
 * the audio it speaks back. The audio is genuine model speech, which is
 * exactly the input this feature has to survive.
 *
 * Output is 24 kHz mono PCM16 wrapped as a WAV, with leading and trailing
 * silence. The trailing silence is load-bearing: server VAD ends a turn after
 * a few hundred milliseconds of quiet, so an utterance that ends flush with
 * the file never gets committed.
 */

import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const RATE = 24000;

export async function synthesize({ endpoint, model, token, text, out, leadMs = 1200, tailMs = 3000 }) {
  const wsURL = endpoint.replace(/^http/, 'ws') + '/realtime?model=' + encodeURIComponent(model);
  const ws = new WebSocket(wsURL, { headers: { Authorization: `Bearer ${token}` } });
  const chunks = [];
  let transcript = '';

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthesize: timed out after 90s')), 90_000);
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.on('message', (data) => {
      let ev;
      try {
        ev = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (ev.type === 'session.created') {
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              output_modalities: ['audio'],
              audio: { output: { format: { type: 'audio/pcm', rate: RATE }, voice: 'alloy' } },
            },
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: `Say exactly this and nothing else: ${text}` }],
            },
          }),
        );
        ws.send(JSON.stringify({ type: 'response.create' }));
      }
      if (ev.type === 'response.output_audio.delta' || ev.type === 'response.audio.delta') {
        chunks.push(Buffer.from(ev.delta, 'base64'));
      }
      if (
        ev.type === 'response.output_audio_transcript.done' ||
        ev.type === 'response.audio_transcript.done'
      ) {
        transcript = ev.transcript;
      }
      if (ev.type === 'error') {
        clearTimeout(timer);
        reject(new Error('synthesize: ' + JSON.stringify(ev.error ?? ev).slice(0, 300)));
      }
      if (ev.type === 'response.done') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  ws.close();

  const speech = Buffer.concat(chunks);
  if (speech.length === 0) throw new Error('synthesize: the endpoint returned no audio');

  const lead = Buffer.alloc(Math.round((leadMs / 1000) * RATE) * 2);
  const tail = Buffer.alloc(Math.round((tailMs / 1000) * RATE) * 2);
  const pcm = Buffer.concat([lead, speech, tail]);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, wav(pcm, RATE));
  return { path: out, seconds: pcm.length / 2 / RATE, transcript };
}

/** Minimal 16-bit mono WAV container. Chromium's fake capture device wants a
 *  plain PCM WAV and nothing more exotic. */
function wav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
