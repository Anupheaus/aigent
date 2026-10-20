import { buildRunRecords } from '../telemetry/build-run-records.js';
import type { BuildRunRecordsParams } from '../telemetry/build-run-records.js';
import { RUNS_COLLECTION, TRACES_COLLECTION } from '../telemetry/collections.js';
import { persistRun } from '../telemetry/persist-run.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import { createRunTimer } from '../telemetry/run-timer.js';
import { createTraceRecorder } from '../telemetry/trace-recorder.js';
import type { RunTelemetry } from './run-turn.js';

/** Per-runtime telemetry configuration, from `createAigent`. */
export interface TelemetrySettings {
  /** Absent without a store: runs are still traced, nothing is written. */
  writer?: RecordWriter;
  /** Whether prompts, answers and argument values are stored. */
  captureContent: boolean;
  /** Retention hint stamped on every record as `expiresAt`. */
  expiresInMs?: number;
}

export interface CreateRunTelemetryParams {
  now(): number;
  settings: TelemetrySettings;
}

export interface PersistRunTelemetryParams {
  now(): number;
  telemetry: RunTelemetry;
  settings: TelemetrySettings;
  /** The finished run, minus what the telemetry itself collected. */
  run: Omit<BuildRunRecordsParams, 'facts'>;
}

/** The collectors for one run; they hold plain data and never write anything themselves. */
export function createRunTelemetry(params: CreateRunTelemetryParams): RunTelemetry {
  const { now, settings: { captureContent } } = params;
  return { recorder: createTraceRecorder({ now, captureContent }), timer: createRunTimer({ now }) };
}

/** Builds the run's records and writes them (redact, then the agent's queue); returns a warning instead of throwing. */
export async function persistRunTelemetry(params: PersistRunTelemetryParams): Promise<string | undefined> {
  const { now, telemetry: { recorder, timer }, settings: { writer, captureContent, expiresInMs }, run } = params;
  if (writer == null) return undefined;
  const recordedAt = now();
  const { run: runRecord, trace } = buildRunRecords({
    ...run,
    facts: { timings: timer.snapshot(), steps: recorder.steps(), captureContent, recordedAt, ...(expiresInMs == null ? {} : { expiresAt: recordedAt + expiresInMs }) },
  });
  const { runId, agentName } = runRecord;
  return persistRun({
    writer,
    queueKey: agentName,
    records: [
      { collection: RUNS_COLLECTION, key: runId, value: runRecord },
      { collection: TRACES_COLLECTION, key: runId, value: trace },
    ],
  });
}
