import { createAigentError } from '../core/aigent-error.js';
import type { Clock } from '../core/runtime-services.js';
import type { Store } from '../store/store-types.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import { CHECKPOINT_HEADS_COLLECTION, CHECKPOINT_SCHEMA_VERSION, CHECKPOINTS_COLLECTION } from './checkpoint-types.js';
import type { Checkpoint, CheckpointBoundary, CheckpointHead, RunState, SessionState } from './checkpoint-types.js';
import { checkpointKey, headKey } from './checkpoint-reader.js';

export const DEFAULT_SNAPSHOT_EVERY = 25;
export const DEFAULT_KEEP_SNAPSHOTS = 2;

/** `createAigent({ resume })` checkpoint settings. */
export interface CheckpointWriterOptions {
  /** A full record every this many checkpoints (default 25); the others hold only appended messages. */
  snapshotEvery?: number;
  /** Snapshots kept (with their tails) when older records are pruned (default 2). Needs `Store.delete`. */
  keepSnapshots?: number;
}

export interface CreateCheckpointWriterParams {
  /** Writes through the keyed queue and `redact`, over the fenced store. */
  records: RecordWriter;
  /** The fenced store, for pruning. */
  store: Store;
  instanceId: string;
  stream: { kind: 'run' | 'session'; id: string };
  fence(): number;
  clock: Clock;
  options?: CheckpointWriterOptions;
  /** The stream's head when it is continued (a resume); the first write then is a snapshot. */
  head?: CheckpointHead;
}

export interface CheckpointWriter {
  /** Appends a checkpoint; resolves once it (and the head) are stored. */
  write(params: { boundary: CheckpointBoundary; state: RunState | SessionState }): Promise<Checkpoint>;
}

/** Messages written so far, as JSON, to tell an append from a rewrite. */
function fingerprints(state: RunState | SessionState): string[] {
  return state.kind === 'run' ? state.context.messages.map(entry => JSON.stringify(entry)) : [];
}

/** Length of the previous messages when the new ones only append to them; undefined when anything before changed. */
function appendedFrom(params: { previous: string[]; next: string[] }): number | undefined {
  const { previous, next } = params;
  if (next.length < previous.length) return undefined;
  return previous.every((entry, index) => entry === next[index]) ? previous.length : undefined;
}

/**
 * Append-only checkpoints of one run or session: seq numbered, a snapshot every `snapshotEvery` (or whenever the
 * history was rewritten, e.g. by a compaction) and deltas of appended messages between them. After each snapshot,
 * records older than the last `keepSnapshots` snapshots are pruned (when the store can delete).
 */
export function createCheckpointWriter(params: CreateCheckpointWriterParams): CheckpointWriter {
  const { records, store, instanceId, stream, fence, clock, options: { snapshotEvery = DEFAULT_SNAPSHOT_EVERY, keepSnapshots = DEFAULT_KEEP_SNAPSHOTS } = {}, head } = params;
  const ref = { instanceId, streamId: stream.id };
  const queueKey = `checkpoint:${headKey(ref)}`;
  let seq = head?.latestSeq ?? 0;
  let snapshots = [...head?.snapshots ?? []];
  let previous: string[] | undefined;

  async function prune(): Promise<void> {
    const deleteRecord = store.delete;
    if (snapshots.length <= keepSnapshots || deleteRecord == null) return;
    const [oldest = 0] = snapshots;
    const kept = snapshots.slice(-keepSnapshots);
    for (let pruned = oldest; pruned < (kept[0] ?? 0); pruned += 1) await deleteRecord.call(store, CHECKPOINTS_COLLECTION, checkpointKey({ ...ref, seq: pruned }));
    snapshots = kept;
  }

  async function write(params: { boundary: CheckpointBoundary; state: RunState | SessionState }): Promise<Checkpoint> {
    const { boundary, state } = params;
    seq += 1;
    const next = fingerprints(state);
    const from = previous == null ? undefined : appendedFrom({ previous, next });
    const lastSnapshot = snapshots.at(-1) ?? 0;
    const isSnapshot = from == null || state.kind !== 'run' || seq - lastSnapshot >= snapshotEvery;
    const stored: RunState | SessionState = isSnapshot || state.kind !== 'run' ? state : { ...state, context: { ...state.context, messages: state.context.messages.slice(from) } };
    const checkpoint: Checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION, instanceId, ...(stream.kind === 'run' ? { runId: stream.id } : { sessionId: stream.id }),
      seq, boundary, at: clock.now(), fence: fence(), isSnapshot, ...(isSnapshot ? {} : { messagesFrom: from }), state: stored,
    };
    const isCreated = await records.create({ queueKey, record: { collection: CHECKPOINTS_COLLECTION, key: checkpointKey({ ...ref, seq }), value: checkpoint } });
    if (!isCreated) throw createAigentError({ code: 'store_conflict', message: `Checkpoint ${seq} of '${headKey(ref)}' already exists; another writer owns this stream`, details: { ...ref, seq } });
    previous = next;
    if (isSnapshot) snapshots.push(seq);
    const nextHead: CheckpointHead = { ...ref, kind: stream.kind, latestSeq: seq, snapshots: [...snapshots], updatedAt: clock.now(), ...(state.kind === 'run' ? { status: state.status } : {}) };
    await records.update<CheckpointHead, CheckpointHead>({ queueKey, collection: CHECKPOINT_HEADS_COLLECTION, key: headKey(ref), patch: () => nextHead, merge: ({ patch }) => patch });
    if (isSnapshot) {
      await prune();
      if (snapshots.length !== nextHead.snapshots.length) await records.update<CheckpointHead, CheckpointHead>({ queueKey, collection: CHECKPOINT_HEADS_COLLECTION, key: headKey(ref), patch: () => ({ ...nextHead, snapshots: [...snapshots] }), merge: ({ patch }) => patch });
    }
    return checkpoint;
  }

  return { write };
}
