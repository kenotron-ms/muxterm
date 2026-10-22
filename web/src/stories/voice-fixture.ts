import type { VoiceInputPort } from '../components/mic-button.js';
import type { VoiceState } from '../lib/voice-input-controller.js';

type Options = { state?: VoiceState; supported?: boolean; failOnStart?: boolean };
type Fixture = VoiceInputPort & { emitError: (message: string) => void };

/** In-memory controller for browser stories. It never starts a microphone. */
export function createVoiceFixture(options: Options = {}): Fixture {
  let current: VoiceState = options.state ?? 'idle';
  const states = new Set<(state: VoiceState) => void>();
  const errors = new Set<(message: string) => void>();
  const setState = (next: VoiceState) => {
    current = next;
    for (const listener of states) listener(next);
  };

  return {
    isSupported: () => options.supported ?? true,
    getState: () => current,
    onStateChange(listener) { states.add(listener); return () => states.delete(listener); },
    onTranscript: () => () => {},
    onError(listener) { errors.add(listener); return () => errors.delete(listener); },
    invalidateIfActive() { if (current === 'listening') setState('idle'); },
    start() {
      if (options.failOnStart) {
        setState('error');
        for (const listener of errors) listener('Microphone unavailable');
      } else {
        setState('listening');
      }
    },
    stop() { setState('idle'); },
    emitError(message) { for (const listener of errors) listener(message); },
  };
}
