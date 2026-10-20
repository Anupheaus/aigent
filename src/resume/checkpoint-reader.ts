import type { Store } from '../store/store-types.js';
import { CHECKPOINT_HEADS_COLLECTION, CHECKPOINTS_COLLECTION } from './checkpoint-types.js';
import type { Checkpoint, CheckpointHead } from './checkpoint-types.js';
import { migrateCheckpoint } from './migrations.js';

/** Digits of the zero-padded seq in a checkpoint key, so keys sort in seq order. */
const SEQ_DIGITS = 10;

export interface StreamRef {
  instanceId: string;
  /** The run id or session id. */
  streamId: string;
}

export function headKey(ref: StreamRef): string {
  return `${ref.instanceId}:${ref.streamId}`;
}

export function checkpointKey(params: StreamRef & { seq: number }): string {
  return `${headKey(params)}:${String(params.seq).padStart(SEQ_DIGITS, '0')}`;
}

/** Folds a later record onto the state so far: a delta replaces the messages from its `messagesFrom` on. */
export function foldCheckpoint(params: { base: Checkpoint; next: Checkpoint }): Checkpoint {
  const { base, next } = params;
  if (next.isSnapshot || next.state.kind !== 'run' || base.state.kind !== 'run') return next;
  const messages = [...base.state.context.messages.slice(0, next.messagesFrom ?? 0), ...next.state.context.messages];
  return { ...next, isSnapshot: true, state: { ...next.state, context: { ...next.state.context, messages } } };
}

export async function readCheckpointHead(params: StreamRef & { store: Store }): Promise<CheckpointHead | undefined> {
  const { store } = params;
  return (await store.get<CheckpointHead>(CHECKPOINT_HEADS_COLLECTION, headKey(params)))?.value;
}

/**
 * The stream's latest checkpoint, folded into one full record: the head, the latest snapshot, then only the records
 * after it (never the whole log). Older schema versions are migrated. Undefined when the stream was never written.
 */
export async function readLatestCheckpoint(params: StreamRef & { store: Store }): Promise<Checkpoint | undefined> {
  const { store } = params;
  const head = await readCheckpointHead(params);
  const snapshotSeq = head?.snapshots.at(-1);
  if (head == null || snapshotSeq == null) return undefined;
  let folded: Checkpoint | undefined;
  for (let seq = snapshotSeq; seq <= head.latestSeq; seq += 1) {
    const stored = await store.get<unknown>(CHECKPOINTS_COLLECTION, checkpointKey({ ...params, seq }));
    // A record missing before the head (lost, or removed outside the library): the stream is readable only up to
    // here, and the caller is told rather than handed an older state as if it were the latest.
    if (stored == null) return folded == null ? undefined : { ...folded, stale: { missingSeq: seq, latestSeq: head.latestSeq } };
    const record = migrateCheckpoint(stored.value);
    folded = folded == null ? record : foldCheckpoint({ base: folded, next: record });
  }
  return folded;
}
