export type MetaEvent = {
  type: string;
  at?: string;
  kind?: string;
  generationId?: string;
  inputId?: string;
  inputIds?: string[];
  toolId?: string;
  raw?: Partial<Record<UsageKey, number>>;
};

export const usageKeys = ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const;
type UsageKey = typeof usageKeys[number];
type Usage = Partial<Record<UsageKey, number>>;

export type MetaTurn = {
  started?: number;
  ended?: number;
  firstOutput?: number;
  outcome?: string;
  tools: Set<string>;
  usage: Usage;
};

function timestamp(at?: string): number | undefined {
  const value = Date.parse(at ?? '');
  return value > 0 ? value : undefined;
}

function measured(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function chatMeta(events: MetaEvent[]) {
  const turns: MetaTurn[] = [];
  const byGeneration = new Map<string, MetaTurn>();
  const snapshots = new Map<string, Usage>();
  let active: MetaTurn | undefined;
  let generation: string | undefined;
  let inputs = new Set<string>();
  const recordedTools = new Set<string>();
  const unassignedTools = new Set<string>();
  let unidentifiedStarts = 0;

  function start() {
    const turn: MetaTurn = {tools: new Set(), usage: {}};
    turns.push(turn);
    inputs = new Set();
    generation = undefined;
    active = turn;
    return turn;
  }

  for (const event of events) {
    const at = timestamp(event.at);
    if (event.type === 'turn.started' || event.type === 'input.accepted') {
      if (event.type === 'input.accepted' && event.kind === 'steer') {
        if (active && event.inputId) inputs.add(event.inputId);
        continue;
      }
      const turn = !active || (event.generationId && generation && generation !== event.generationId) ||
        (event.inputId && inputs.size > 0 && !inputs.has(event.inputId)) ? start() : active;
      turn.started ??= at;
      if (event.inputId) inputs.add(event.inputId);
      if (event.generationId) {
        generation = event.generationId;
        byGeneration.set(generation, turn);
      }
      continue;
    }

    if (event.type === 'usage.observed' && event.raw) {
      if (event.kind === 'thread-total' && event.generationId) {
        snapshots.set(event.generationId, event.raw);
      } else if (event.kind === 'result' && active && event.inputIds?.some(id => inputs.has(id))) {
        for (const key of usageKeys) {
          const value = event.raw[key];
          if (measured(value)) active.usage[key] = (active.usage[key] ?? 0) + value;
        }
      }
      continue;
    }

    if (event.type === 'tool.started' || event.type === 'tool.completed') {
      const id = event.toolId;
      // These IDs represent plan updates rendered as tools by the transcript.
      if (id === 'acp-plan' || id?.startsWith('codex-plan:')) continue;
      if (id) {
        if (!recordedTools.has(id)) {
          if (active) active.tools.add(id);
          else unassignedTools.add(id);
          recordedTools.add(id);
        }
      } else if (event.type === 'tool.started') {
        unidentifiedStarts++;
      }
    }

    if (active && (event.type === 'assistant.delta' || event.type === 'commentary.delta')) {
      active.firstOutput ??= at;
    }
    if (['turn.completed', 'turn.cancelled', 'error', 'session.uncertain'].includes(event.type)) {
      const turn = event.generationId ? byGeneration.get(event.generationId) : active;
      if (!turn || turn.outcome) continue;
      if (event.inputIds?.length && inputs.size && turn === active && !event.inputIds.some(id => inputs.has(id))) continue;
      turn.outcome = event.type === 'error' ? 'Error' : event.type === 'session.uncertain' ? 'Uncertain'
        : event.type === 'turn.cancelled' ? 'Cancelled' : 'Completed';
      turn.ended = at;
      if (turn === active) active = undefined;
    }
  }

  // A cumulative snapshot from a resumed thread has an unknown baseline.
  // Adjacent recorded turns with snapshots support a delta for the later turn.
  let previous: Usage | undefined;
  for (const [id, turn] of byGeneration) {
    const total = snapshots.get(id);
    if (total && previous && turn.outcome) {
      for (const key of usageKeys) {
        const before = previous[key], after = total[key];
        if (measured(before) && measured(after) && after >= before) turn.usage[key] = after - before;
      }
    }
    previous = turn.outcome ? total : undefined;
  }
  return {turns, orphanTools: unassignedTools.size + unidentifiedStarts};
}

export function elapsed(start?: number, end?: number) {
  return start !== undefined && end !== undefined && end >= start ? end - start : undefined;
}
