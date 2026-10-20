import { createAigentError } from '../core/aigent-error.js';
import { CHECKPOINT_SCHEMA_VERSION } from './checkpoint-types.js';
import type { Checkpoint, CheckpointBoundary, RunState, SessionState } from './checkpoint-types.js';

/**
 * The pre-release (v0) record: one stream id instead of `runId`/`sessionId`, the boundary under `kind`, no fence
 * and always a full record. Kept so the migration path is exercised before a real v2 exists.
 */
export interface CheckpointV0 {
  version: 0;
  instanceId: string;
  streamId: string;
  seq: number;
  kind: CheckpointBoundary;
  at: number;
  state: RunState | SessionState;
}

type Migration = (record: Record<string, unknown>) => Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** v0 → v1: split the stream id by the state's kind, rename `kind`, fence 0 (written before leases), full record. */
const fromV0: Migration = record => {
  const { streamId, kind, version: _version, ...rest } = record as unknown as CheckpointV0;
  const ids = rest.state.kind === 'run' ? { runId: streamId } : { sessionId: streamId };
  return { ...rest, ...ids, schemaVersion: 1, boundary: kind, fence: 0, isSnapshot: true };
};

/** Upgrades keyed by the version they read. */
const MIGRATIONS: ReadonlyMap<number, Migration> = new Map([[0, fromV0]]);

function versionOf(record: Record<string, unknown>): number | undefined {
  const version = record.schemaVersion ?? record.version;
  return typeof version === 'number' ? version : undefined;
}

/**
 * Upgrades a stored checkpoint to the current schema, one version at a time. Throws `invalid_input` for a record
 * that is not a checkpoint, or one from a newer (or unknown) version.
 */
export function migrateCheckpoint(stored: unknown): Checkpoint {
  if (!isRecord(stored)) throw createAigentError({ code: 'invalid_input', message: 'A checkpoint record must be an object', details: { type: typeof stored } });
  let record = stored;
  for (let version = versionOf(record); version !== CHECKPOINT_SCHEMA_VERSION; version = versionOf(record)) {
    const migration = version == null ? undefined : MIGRATIONS.get(version);
    if (migration == null) {
      throw createAigentError({ code: 'invalid_input', message: `Cannot read checkpoint schema version ${String(version)}; this library reads versions 0 to ${CHECKPOINT_SCHEMA_VERSION}`, details: { schemaVersion: version } });
    }
    record = migration(record);
  }
  return record as unknown as Checkpoint;
}
