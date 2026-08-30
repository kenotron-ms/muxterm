import {
  SessiondRecoveredHistoryMaxBytes,
  SessiondRecoveredHistoryMaxLines,
  SessiondRecoveredHistoryMaxParts,
  type SessiondRecoveredHistoryLiteral,
} from '../types.js';

export const RecoveredHistoryPaneMaxBytes = 64 * 1024;
export const RecoveredHistoryPaneMaxLines = 4096;
export const RecoveredHistoryMaxRecords = 256;
export const RecoveredHistoryGlobalMaxBytes = 4 * 1024 * 1024;
export const RecoveredHistoryMaxBindings = 1024;
export const RecoveredHistoryAssemblyMaxBytes = 1024 * 1024;
export const RecoveredHistoryReplayMaxBytes = 4 * 1024 * 1024;

const MAX_WORKSPACE_ID_BYTES = 128;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const CANONICAL_UINT64 = /^[1-9][0-9]*$/u;
const encoder = new TextEncoder();

export interface RecoveredHistoryRecord {
  readonly key: string;
  readonly workspaceId: string;
  readonly paneId: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly byteLength: number;
  readonly lineCount: number;
}

export interface RecoveredHistorySnapshot {
  readonly records: readonly RecoveredHistoryRecord[];
  readonly totalBytes: number;
}

interface InternalRecord {
  readonly value: RecoveredHistoryRecord;
}

interface ParsedText {
  readonly text: string;
  readonly byteLength: number;
  readonly lineCount: number;
}

interface BoundedText extends ParsedText {
  readonly trimmed: boolean;
}

interface SegmentIdentity {
  readonly generation: bigint;
  readonly sequence: bigint;
  readonly generationText: string;
  readonly sequenceText: string;
  readonly key: string;
}

interface ParsedPane {
  readonly key: string;
  readonly workspaceId: string;
  readonly paneId: number;
}

interface ParsedHistoryLiteral {
  readonly identity: SegmentIdentity;
  readonly pane: ParsedPane;
  readonly part: number;
  readonly final: boolean;
  readonly text: string;
  readonly truncated: boolean;
  readonly byteLength: number;
}

interface StoredFragment {
  readonly part: number;
  readonly final: boolean;
  readonly truncated: boolean;
  readonly text: string;
  readonly byteLength: number;
}

type SegmentBindingState = 'pending' | 'committed' | 'poisoned';

interface SegmentBinding {
  readonly identity: SegmentIdentity;
  readonly pane: ParsedPane;
  readonly fragments: Map<number, StoredFragment>;
  state: SegmentBindingState;
  nextPart: number;
  finalPart: number | undefined;
  textBytes: number;
}

interface PaneReplayState {
  readonly pane: ParsedPane;
  highWater: SegmentIdentity;
  pendingKey: string | undefined;
}

type HistoryListener = (snapshot: RecoveredHistorySnapshot) => void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
  }
  return true;
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key)) &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function logicalLineCount(value: string): number {
  if (value.length === 0) return 0;
  let lines = value.endsWith('\n') ? 0 : 1;
  for (const character of value) {
    if (character === '\n') lines++;
  }
  return lines;
}

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

function parseWorkspaceID(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8ByteLength(value) > MAX_WORKSPACE_ID_BYTES ||
    /[\p{Cc}]/u.test(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes(':') ||
    value.includes('..')
  ) {
    return null;
  }
  return value;
}

function isPaneID(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 0xffff_ffff
  );
}

function historyKey(workspaceId: unknown, paneId: unknown): string | null {
  const parsedWorkspaceID = parseWorkspaceID(workspaceId);
  if (parsedWorkspaceID === null || !isPaneID(paneId)) return null;
  return `${parsedWorkspaceID}:${paneId}`;
}

function parsePane(value: unknown): ParsedPane | null {
  if (!hasExactKeys(value, ['workspaceId', 'paneId'])) return null;
  const workspaceId = parseWorkspaceID(value.workspaceId);
  const paneId = value.paneId;
  const key = historyKey(workspaceId, paneId);
  return workspaceId === null || !isPaneID(paneId) || key === null
    ? null
    : { key, workspaceId, paneId };
}

function parseCanonicalUint64(value: unknown): { readonly text: string; readonly value: bigint } | null {
  if (
    typeof value !== 'string' ||
    value.length > 20 ||
    !CANONICAL_UINT64.test(value)
  ) {
    return null;
  }
  try {
    const parsed = BigInt(value);
    if (parsed === 0n || parsed > MAX_UINT64 || parsed.toString() !== value) return null;
    return { text: parsed.toString(), value: parsed };
  } catch {
    return null;
  }
}

function parseIdentity(value: unknown): SegmentIdentity | null {
  if (!hasExactKeys(value, ['generation', 'sequence'])) return null;
  const generation = parseCanonicalUint64(value.generation);
  const sequence = parseCanonicalUint64(value.sequence);
  if (generation === null || sequence === null) return null;
  return {
    generation: generation.value,
    sequence: sequence.value,
    generationText: generation.text,
    sequenceText: sequence.text,
    key: `${generation.text}/${sequence.text}`,
  };
}

function parseRecoveredHistoryText(value: unknown): ParsedText | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !hasOnlyUnicodeScalarValues(value)
  ) {
    return null;
  }
  const byteLength = utf8ByteLength(value);
  if (byteLength > SessiondRecoveredHistoryMaxBytes) return null;

  for (const character of value) {
    if (character !== '\n' && /[\p{Cc}\p{Cf}]/u.test(character)) return null;
  }
  const lineCount = logicalLineCount(value);
  return lineCount > SessiondRecoveredHistoryMaxLines ? null : { text: value, byteLength, lineCount };
}

function parsePart(value: unknown, final: boolean): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= SessiondRecoveredHistoryMaxParts - 1 ||
    (value === SessiondRecoveredHistoryMaxParts - 2 && !final)
  ) {
    return null;
  }
  return value;
}

function parseHistoryLiteral(value: unknown): ParsedHistoryLiteral | null {
  if (!hasExactKeys(value, ['segmentId', 'part', 'final', 'pane', 'text', 'truncated'])) return null;
  if (typeof value.final !== 'boolean' || typeof value.truncated !== 'boolean') return null;
  const identity = parseIdentity(value.segmentId);
  const part = parsePart(value.part, value.final);
  const pane = parsePane(value.pane);
  const text = parseRecoveredHistoryText(value.text);
  if (
    identity === null ||
    part === null ||
    pane === null ||
    text === null ||
    (value.truncated && part !== 0)
  ) {
    return null;
  }
  return {
    identity,
    pane,
    part,
    final: value.final,
    text: text.text,
    truncated: value.truncated,
    byteLength: text.byteLength,
  };
}

function identityLess(left: SegmentIdentity, right: SegmentIdentity): boolean {
  return (
    left.generation < right.generation ||
    (left.generation === right.generation && left.sequence < right.sequence)
  );
}

function freezeRecord(
  key: string,
  workspaceId: string,
  paneId: number,
  text: string,
  truncated: boolean,
  byteLength = utf8ByteLength(text),
  lineCount = logicalLineCount(text),
): RecoveredHistoryRecord {
  return Object.freeze({
    key,
    workspaceId,
    paneId,
    text,
    truncated,
    byteLength,
    lineCount,
  });
}

function sameVisibleRecord(left: RecoveredHistoryRecord, right: RecoveredHistoryRecord): boolean {
  return (
    left.key === right.key &&
    left.workspaceId === right.workspaceId &&
    left.paneId === right.paneId &&
    left.text === right.text &&
    left.truncated === right.truncated &&
    left.byteLength === right.byteLength &&
    left.lineCount === right.lineCount
  );
}

function toStoredFragment(input: ParsedHistoryLiteral): StoredFragment {
  return {
    part: input.part,
    final: input.final,
    truncated: input.truncated,
    text: input.text,
    byteLength: input.byteLength,
  };
}

/**
 * This comparison corroborates a replay only after the immutable full-ID
 * binding selected its segment; fragment text is never used as an identity.
 */
function isExactFragmentReplay(stored: StoredFragment, input: ParsedHistoryLiteral): boolean {
  return (
    stored.part === input.part &&
    stored.final === input.final &&
    stored.truncated === input.truncated &&
    stored.text === input.text &&
    stored.byteLength === input.byteLength
  );
}

function boundPaneText(value: string): BoundedText | null {
  let byteLength = utf8ByteLength(value);
  let lineCount = logicalLineCount(value);
  if (
    byteLength <= RecoveredHistoryPaneMaxBytes &&
    lineCount <= RecoveredHistoryPaneMaxLines
  ) {
    return { text: value, byteLength, lineCount, trimmed: false };
  }

  let start = 0;
  while (
    byteLength > RecoveredHistoryPaneMaxBytes ||
    lineCount > RecoveredHistoryPaneMaxLines
  ) {
    const newline = value.indexOf('\n', start);
    if (newline < 0) return null;
    const next = newline + 1;
    byteLength -= utf8ByteLength(value.slice(start, next));
    lineCount--;
    start = next;
  }

  return {
    text: value.slice(start),
    byteLength,
    lineCount,
    trimmed: start > 0,
  };
}

const emptySnapshot: RecoveredHistorySnapshot = Object.freeze({
  records: Object.freeze([]) as readonly RecoveredHistoryRecord[],
  totalBytes: 0,
});

export class RecoveredHistoryStore {
  readonly #records = new Map<string, InternalRecord>();
  readonly #paneStates = new Map<string, PaneReplayState>();
  readonly #bindings = new Map<string, SegmentBinding>();
  readonly #listeners = new Set<HistoryListener>();
  #snapshot: RecoveredHistorySnapshot = emptySnapshot;
  #totalBytes = 0;
  #replayTextBytes = 0;

  get(workspaceId: string, paneId: number): RecoveredHistoryRecord | undefined {
    const key = historyKey(workspaceId, paneId);
    return key === null ? undefined : this.#records.get(key)?.value;
  }

  snapshot(): RecoveredHistorySnapshot {
    return this.#snapshot;
  }

  subscribe(listener: HistoryListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  append(literal: SessiondRecoveredHistoryLiteral): boolean {
    const input = parseHistoryLiteral(literal);
    if (input === null) return false;

    const binding = this.#bindings.get(input.identity.key);
    return binding === undefined
      ? this._appendUnbound(input)
      : this._appendBound(binding, input);
  }

  delete(workspaceId: string, paneId: number): boolean {
    const key = historyKey(workspaceId, paneId);
    if (key === null) return false;
    const visibleChanged = this.#records.has(key);
    const changed = this._removePane(key);
    if (visibleChanged) this._publish();
    return changed;
  }

  clearWorkspace(workspaceId: string): boolean {
    if (parseWorkspaceID(workspaceId) === null) return false;
    const keys = this._paneKeysMatching((pane) => pane.workspaceId === workspaceId);
    return this._removePanes(keys);
  }

  retainWorkspaces(workspaceIds: ReadonlySet<string>): boolean {
    const keys = this._paneKeysMatching((pane) => !workspaceIds.has(pane.workspaceId));
    return this._removePanes(keys);
  }

  reconcileWorkspacePanes(workspaceId: string, paneIds: ReadonlySet<number>): boolean {
    if (parseWorkspaceID(workspaceId) === null) return false;
    const keys = this._paneKeysMatching(
      (pane) => pane.workspaceId === workspaceId && !paneIds.has(pane.paneId),
    );
    return this._removePanes(keys);
  }

  clearAll(): boolean {
    const visibleChanged = this.#records.size !== 0;
    const changed =
      visibleChanged ||
      this.#paneStates.size !== 0 ||
      this.#bindings.size !== 0 ||
      this.#totalBytes !== 0 ||
      this.#replayTextBytes !== 0;
    if (!changed) return false;

    this.#records.clear();
    this.#paneStates.clear();
    this.#bindings.clear();
    this.#totalBytes = 0;
    this.#replayTextBytes = 0;
    if (visibleChanged) this._publish();
    return true;
  }

  private _appendUnbound(input: ParsedHistoryLiteral): boolean {
    const existingState = this.#paneStates.get(input.pane.key);
    if (input.part !== 0) {
      this._poisonUnbound(input, existingState);
      return false;
    }
    if (existingState !== undefined && !identityLess(existingState.highWater, input.identity)) {
      return false;
    }
    if (
      (existingState === undefined && this.#paneStates.size >= RecoveredHistoryMaxRecords) ||
      this.#bindings.size >= RecoveredHistoryMaxBindings ||
      input.byteLength > RecoveredHistoryAssemblyMaxBytes ||
      this.#replayTextBytes > RecoveredHistoryReplayMaxBytes - input.byteLength
    ) {
      return false;
    }

    if (existingState?.pendingKey !== undefined) {
      const pending = this.#bindings.get(existingState.pendingKey);
      if (pending !== undefined) this._poisonBinding(pending);
    }

    const state =
      existingState ??
      {
        pane: input.pane,
        highWater: input.identity,
        pendingKey: undefined,
      };
    if (existingState === undefined) this.#paneStates.set(input.pane.key, state);
    state.highWater = input.identity;

    const fragment = toStoredFragment(input);
    const binding: SegmentBinding = {
      identity: input.identity,
      pane: input.pane,
      fragments: new Map([[input.part, fragment]]),
      state: 'pending',
      nextPart: input.part + 1,
      finalPart: input.final ? input.part : undefined,
      textBytes: input.byteLength,
    };
    this.#bindings.set(input.identity.key, binding);
    this.#replayTextBytes += input.byteLength;

    if (input.final) {
      this._commitBinding(binding);
    } else {
      state.pendingKey = input.identity.key;
    }
    return true;
  }

  private _appendBound(binding: SegmentBinding, input: ParsedHistoryLiteral): boolean {
    if (binding.pane.key !== input.pane.key) {
      if (binding.state === 'pending') this._poisonBinding(binding);
      return false;
    }

    const stored = binding.fragments.get(input.part);
    if (stored !== undefined) {
      if (isExactFragmentReplay(stored, input)) return false;
      if (binding.state === 'pending') this._poisonBinding(binding);
      return false;
    }
    if (binding.state !== 'pending') return false;

    const state = this.#paneStates.get(binding.pane.key);
    if (
      state === undefined ||
      state.pendingKey !== binding.identity.key ||
      state.highWater.key !== binding.identity.key ||
      input.part !== binding.nextPart ||
      binding.finalPart !== undefined ||
      input.byteLength > RecoveredHistoryAssemblyMaxBytes - binding.textBytes ||
      this.#replayTextBytes > RecoveredHistoryReplayMaxBytes - input.byteLength
    ) {
      this._poisonBinding(binding);
      return false;
    }

    binding.fragments.set(input.part, toStoredFragment(input));
    binding.nextPart = input.part + 1;
    binding.textBytes += input.byteLength;
    this.#replayTextBytes += input.byteLength;
    if (input.final) {
      binding.finalPart = input.part;
      this._commitBinding(binding);
    }
    return true;
  }

  private _poisonUnbound(input: ParsedHistoryLiteral, existingState: PaneReplayState | undefined): void {
    if (
      (existingState !== undefined && !identityLess(existingState.highWater, input.identity)) ||
      (existingState === undefined && this.#paneStates.size >= RecoveredHistoryMaxRecords) ||
      this.#bindings.size >= RecoveredHistoryMaxBindings
    ) {
      return;
    }

    if (existingState?.pendingKey !== undefined) {
      const pending = this.#bindings.get(existingState.pendingKey);
      if (pending !== undefined) this._poisonBinding(pending);
    }

    const state =
      existingState ??
      {
        pane: input.pane,
        highWater: input.identity,
        pendingKey: undefined,
      };
    if (existingState === undefined) this.#paneStates.set(input.pane.key, state);
    state.highWater = input.identity;
    this.#bindings.set(input.identity.key, {
      identity: input.identity,
      pane: input.pane,
      fragments: new Map(),
      state: 'poisoned',
      nextPart: 0,
      finalPart: undefined,
      textBytes: 0,
    });
  }

  private _poisonBinding(binding: SegmentBinding): void {
    if (binding.state !== 'pending') return;
    const state = this.#paneStates.get(binding.pane.key);
    if (state?.pendingKey === binding.identity.key) state.pendingKey = undefined;
    this.#replayTextBytes -= binding.textBytes;
    binding.fragments.clear();
    binding.state = 'poisoned';
    binding.nextPart = 0;
    binding.finalPart = undefined;
    binding.textBytes = 0;
  }

  private _commitBinding(binding: SegmentBinding): void {
    const finalPart = binding.finalPart;
    if (finalPart === undefined) {
      this._poisonBinding(binding);
      return;
    }

    const fragments: string[] = [];
    for (let part = 0; part <= finalPart; part++) {
      const fragment = binding.fragments.get(part);
      if (fragment === undefined) {
        this._poisonBinding(binding);
        return;
      }
      fragments.push(fragment.text);
    }

    const first = binding.fragments.get(0);
    if (first === undefined) {
      this._poisonBinding(binding);
      return;
    }
    binding.state = 'committed';
    const state = this.#paneStates.get(binding.pane.key);
    if (state?.pendingKey === binding.identity.key) state.pendingKey = undefined;
    this._appendVisible(binding.pane, fragments.join(''), first.truncated);
  }

  private _appendVisible(pane: ParsedPane, text: string, truncated: boolean): void {
    const existing = this.#records.get(pane.key);
    const candidate = `${existing?.value.text ?? ''}${text}`;
    const bounded = boundPaneText(candidate);
    if (bounded === null) {
      if (!existing || existing.value.truncated) return;
      this.#records.set(pane.key, {
        value: freezeRecord(
          pane.key,
          pane.workspaceId,
          pane.paneId,
          existing.value.text,
          true,
          existing.value.byteLength,
          existing.value.lineCount,
        ),
      });
      this._publishIfVisibleChanged();
      return;
    }

    if (existing) {
      this.#records.delete(pane.key);
      this.#totalBytes -= existing.value.byteLength;
    }
    const value = freezeRecord(
      pane.key,
      pane.workspaceId,
      pane.paneId,
      bounded.text,
      (existing?.value.truncated ?? false) || truncated || bounded.trimmed,
      bounded.byteLength,
      bounded.lineCount,
    );
    this.#records.set(pane.key, { value });
    this.#totalBytes += value.byteLength;
    this._enforcePressure();
    this._publishIfVisibleChanged();
  }

  private _paneKeysMatching(predicate: (pane: ParsedPane) => boolean): Set<string> {
    const keys = new Set<string>();
    for (const [key, record] of this.#records) {
      if (predicate(record.value)) keys.add(key);
    }
    for (const [key, state] of this.#paneStates) {
      if (predicate(state.pane)) keys.add(key);
    }
    for (const binding of this.#bindings.values()) {
      if (predicate(binding.pane)) keys.add(binding.pane.key);
    }
    return keys;
  }

  private _removePanes(keys: ReadonlySet<string>): boolean {
    let changed = false;
    let visibleChanged = false;
    for (const key of keys) {
      visibleChanged = this.#records.has(key) || visibleChanged;
      changed = this._removePane(key) || changed;
    }
    if (visibleChanged) this._publish();
    return changed;
  }

  private _removePane(key: string): boolean {
    let changed = false;
    const record = this.#records.get(key);
    if (record !== undefined) {
      this.#records.delete(key);
      this.#totalBytes -= record.value.byteLength;
      changed = true;
    }
    if (this.#paneStates.delete(key)) changed = true;
    for (const [identityKey, binding] of this.#bindings) {
      if (binding.pane.key !== key) continue;
      this.#replayTextBytes -= binding.textBytes;
      this.#bindings.delete(identityKey);
      changed = true;
    }
    return changed;
  }

  private _enforcePressure(): void {
    while (this.#records.size > RecoveredHistoryMaxRecords) {
      this._evictOldestVisible();
    }

    while (this.#totalBytes > RecoveredHistoryGlobalMaxBytes) {
      const oldest = this.#records.entries().next().value as
        | [string, InternalRecord]
        | undefined;
      if (!oldest) break;
      const [key, record] = oldest;
      const requiredBytes = this.#totalBytes - RecoveredHistoryGlobalMaxBytes;
      let removedBytes = 0;
      let removedLines = 0;
      let cut = 0;

      while (removedBytes < requiredBytes) {
        const newline = record.value.text.indexOf('\n', cut);
        if (newline < 0) break;
        const next = newline + 1;
        removedBytes += utf8ByteLength(record.value.text.slice(cut, next));
        removedLines++;
        cut = next;
      }

      if (cut === 0) {
        this._evictOldestVisible();
        continue;
      }

      const text = record.value.text.slice(cut);
      this.#totalBytes -= removedBytes;
      if (text.length === 0) {
        this.#records.delete(key);
        continue;
      }
      this.#records.set(key, {
        value: freezeRecord(
          key,
          record.value.workspaceId,
          record.value.paneId,
          text,
          true,
          record.value.byteLength - removedBytes,
          record.value.lineCount - removedLines,
        ),
      });
    }
  }

  private _evictOldestVisible(): void {
    const oldest = this.#records.entries().next().value as
      | [string, InternalRecord]
      | undefined;
    if (!oldest) return;
    this.#records.delete(oldest[0]);
    this.#totalBytes -= oldest[1].value.byteLength;
  }

  private _sortedRecords(): RecoveredHistoryRecord[] {
    return [...this.#records.values()]
      .map((record) => record.value)
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  }

  private _publishIfVisibleChanged(): boolean {
    const records = this._sortedRecords();
    if (
      this.#snapshot.totalBytes === this.#totalBytes &&
      this.#snapshot.records.length === records.length &&
      this.#snapshot.records.every((record, index) => sameVisibleRecord(record, records[index]!))
    ) {
      return false;
    }
    this._publish(records);
    return true;
  }

  private _publish(records = this._sortedRecords()): void {
    this.#snapshot = Object.freeze({
      records: Object.freeze(records),
      totalBytes: this.#totalBytes,
    });
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}

export const recoveredHistoryStore = new RecoveredHistoryStore();