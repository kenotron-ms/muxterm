import {
  SessiondRecoveredHistoryMaxBytes,
  SessiondRecoveredHistoryMaxLines,
  type SessiondRecoveredHistoryLiteral,
} from '../types.js';

export const RecoveredHistoryPaneMaxBytes = 64 * 1024;
export const RecoveredHistoryPaneMaxLines = 4096;
export const RecoveredHistoryMaxRecords = 256;
export const RecoveredHistoryGlobalMaxBytes = 4 * 1024 * 1024;

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
  readonly lastSegmentText: string;
}

interface BoundedText {
  readonly text: string;
  readonly byteLength: number;
  readonly lineCount: number;
  readonly trimmed: boolean;
}

type HistoryListener = (snapshot: RecoveredHistorySnapshot) => void;

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

function historyKey(workspaceId: unknown, paneId: unknown): string | null {
  if (
    typeof workspaceId !== 'string' ||
    workspaceId.length === 0 ||
    workspaceId.includes(':') ||
    typeof paneId !== 'number' ||
    !Number.isSafeInteger(paneId) ||
    paneId <= 0 ||
    paneId > 0xffff_ffff
  ) {
    return null;
  }
  return `${workspaceId}:${paneId}`;
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

const emptySnapshot: RecoveredHistorySnapshot = Object.freeze({
  records: Object.freeze([]) as readonly RecoveredHistoryRecord[],
  totalBytes: 0,
});

export class RecoveredHistoryStore {
  readonly #records = new Map<string, InternalRecord>();
  readonly #listeners = new Set<HistoryListener>();
  #snapshot: RecoveredHistorySnapshot = emptySnapshot;
  #totalBytes = 0;

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
    const input = literal as unknown as {
      pane?: { workspaceId?: unknown; paneId?: unknown };
      text?: unknown;
      truncated?: unknown;
    };
    const workspaceId = input?.pane?.workspaceId;
    const paneId = input?.pane?.paneId;
    const key = historyKey(workspaceId, paneId);
    const text = input?.text;
    const truncated = input?.truncated;
    if (
      key === null ||
      typeof workspaceId !== 'string' ||
      typeof paneId !== 'number' ||
      typeof text !== 'string' ||
      text.length === 0 ||
      typeof truncated !== 'boolean'
    ) {
      return false;
    }

    const segmentBytes = utf8ByteLength(text);
    if (
      segmentBytes > SessiondRecoveredHistoryMaxBytes ||
      logicalLineCount(text) > SessiondRecoveredHistoryMaxLines
    ) {
      return false;
    }

    const existing = this.#records.get(key);
    if (existing?.lastSegmentText === text) {
      if (!truncated || existing.value.truncated) return false;
      const nextValue = freezeRecord(
        key,
        workspaceId,
        paneId,
        existing.value.text,
        true,
        existing.value.byteLength,
        existing.value.lineCount,
      );
      this.#records.set(key, {
        value: nextValue,
        lastSegmentText: existing.lastSegmentText,
      });
      this._publishIfVisibleChanged();
      return true;
    }

    const candidate = `${existing?.value.text ?? ''}${text}`;
    const bounded = boundPaneText(candidate);
    if (bounded === null) {
      if (!existing) return false;
      const visibleChanged = !existing.value.truncated;
      this.#records.set(key, {
        value: visibleChanged
          ? freezeRecord(
              key,
              workspaceId,
              paneId,
              existing.value.text,
              true,
              existing.value.byteLength,
              existing.value.lineCount,
            )
          : existing.value,
        lastSegmentText: text,
      });
      if (visibleChanged) this._publish();
      return visibleChanged;
    }

    if (existing) {
      this.#records.delete(key);
      this.#totalBytes -= existing.value.byteLength;
    }
    const nextValue = freezeRecord(
      key,
      workspaceId,
      paneId,
      bounded.text,
      (existing?.value.truncated ?? false) || truncated || bounded.trimmed,
      bounded.byteLength,
      bounded.lineCount,
    );
    this.#records.set(key, { value: nextValue, lastSegmentText: text });
    this.#totalBytes += nextValue.byteLength;

    this._enforcePressure();
    this._publishIfVisibleChanged();
    return true;
  }

  delete(workspaceId: string, paneId: number): boolean {
    const key = historyKey(workspaceId, paneId);
    if (key === null) return false;
    const record = this.#records.get(key);
    if (!record) return false;
    this.#records.delete(key);
    this.#totalBytes -= record.value.byteLength;
    this._publish();
    return true;
  }

  clearWorkspace(workspaceId: string): boolean {
    if (historyKey(workspaceId, 1) === null) return false;
    let changed = false;
    for (const [key, record] of this.#records) {
      if (record.value.workspaceId !== workspaceId) continue;
      this.#records.delete(key);
      this.#totalBytes -= record.value.byteLength;
      changed = true;
    }
    if (changed) this._publish();
    return changed;
  }

  retainWorkspaces(workspaceIds: ReadonlySet<string>): boolean {
    let changed = false;
    for (const [key, record] of this.#records) {
      if (workspaceIds.has(record.value.workspaceId)) continue;
      this.#records.delete(key);
      this.#totalBytes -= record.value.byteLength;
      changed = true;
    }
    if (changed) this._publish();
    return changed;
  }

  reconcileWorkspacePanes(workspaceId: string, paneIds: ReadonlySet<number>): boolean {
    if (historyKey(workspaceId, 1) === null) return false;
    let changed = false;
    for (const [key, record] of this.#records) {
      if (record.value.workspaceId !== workspaceId || paneIds.has(record.value.paneId)) {
        continue;
      }
      this.#records.delete(key);
      this.#totalBytes -= record.value.byteLength;
      changed = true;
    }
    if (changed) this._publish();
    return changed;
  }

  clearAll(): boolean {
    if (this.#records.size === 0) return false;
    this.#records.clear();
    this.#totalBytes = 0;
    this._publish();
    return true;
  }

  private _enforcePressure(): void {
    while (this.#records.size > RecoveredHistoryMaxRecords) {
      this._evictOldest();
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
        this._evictOldest();
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
        lastSegmentText: record.lastSegmentText,
      });
    }
  }

  private _evictOldest(): void {
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