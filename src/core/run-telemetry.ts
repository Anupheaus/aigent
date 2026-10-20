import type { CollectedFeedback } from '../feedback/feedback-collector.js';
import { FEEDBACK_COLLECTION, RESPONSES_COLLECTION } from '../feedback/feedback-records.js';
import type { AgentFeedbackEntry, AgentFeedbackRecord, ResponseIndexRecord, StoredAgentFeedbackEntry } from '../feedback/feedback-records.js';
import { FEEDBACK_TOOL_NAME } from '../feedback/feedback-tool.js';
import { buildRunRecords } from '../telemetry/build-run-records.js';
import type { BuildRunRecordsParams } from '../telemetry/build-run-records.js';
import { RUNS_COLLECTION, TRACES_COLLECTION } from '../telemetry/collections.js';
import { persistRun } from '../telemetry/persist-run.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import type { RedactableRecord } from '../telemetry/redact.js';
import type { RecordMeta } from '../telemetry/run-record.js';
import { createRunTimer } from '../telemetry/run-timer.js';
import { summariseToolUse } from '../telemetry/summarise-tool-use.js';
import { createTraceRecorder } from '../telemetry/trace-recorder.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';
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
  /** The agent's resolved `enableFeedback`. */
  enableFeedback: boolean;
}

export interface PersistRunTelemetryParams {
  now(): number;
  telemetry: RunTelemetry;
  settings: TelemetrySettings;
  /** The finished run, minus what the telemetry itself collected. */
  run: Omit<BuildRunRecordsParams, 'facts'>;
  /** The run's `aigent_feedback` entries. */
  feedback: CollectedFeedback[];
}

/** An entry as stored: its text only with content capture on, its length otherwise. */
function storedEntry(params: { entry: AgentFeedbackEntry; captureContent: boolean }): StoredAgentFeedbackEntry {
  const { entry, captureContent } = params;
  if (captureContent) return entry;
  const { text, ...rest } = entry;
  return { ...rest, textLength: text.length };
}

function agentFeedbackRecord(params: { meta: RecordMeta; collected: CollectedFeedback; captureContent: boolean }): RedactableRecord {
  const { meta, collected: { runId, callId, index, entry }, captureContent } = params;
  const value: AgentFeedbackRecord = { ...meta, kind: 'agent', callId, index, entry: storedEntry({ entry, captureContent }) };
  return { collection: FEEDBACK_COLLECTION, key: `${runId}:${callId}:${index}`, value };
}

/** The collectors for one run; they hold plain data and never write anything themselves. */
export function createRunTelemetry(params: CreateRunTelemetryParams): RunTelemetry {
  const { now, settings: { captureContent }, enableFeedback } = params;
  return {
    // aigent_feedback is commentary, not work, so outcomes never attach to it.
    recorder: createTraceRecorder({ now, captureContent, nonOutcomeTools: [FEEDBACK_TOOL_NAME] }),
    timer: createRunTimer({ now }),
    feedback: { isEnabled: enableFeedback, hasWarnedMissing: false },
  };
}

/** Builds the run's records and writes them (redact, then the agent's queue); returns a warning instead of throwing. */
export async function persistRunTelemetry(params: PersistRunTelemetryParams): Promise<string | undefined> {
  const { now, telemetry: { recorder, timer }, settings: { writer, captureContent, expiresInMs }, run, feedback } = params;
  if (writer == null) return undefined;
  const recordedAt = now();
  const steps = recorder.steps();
  const toolUse = summariseToolUse({ steps, nonWorkTools: [MULTI_TOOL_NAME, FEEDBACK_TOOL_NAME] });
  const { meta, run: runRecord, trace } = buildRunRecords({
    ...run,
    facts: { timings: timer.snapshot(), steps, toolUse, captureContent, recordedAt, ...(expiresInMs == null ? {} : { expiresAt: recordedAt + expiresInMs }) },
  });
  const { runId, agentName, responseId } = runRecord;
  const responseIndex: ResponseIndexRecord = { ...meta, responseId };
  return persistRun({
    writer,
    queueKey: agentName,
    records: [
      { collection: RUNS_COLLECTION, key: runId, value: runRecord },
      { collection: TRACES_COLLECTION, key: runId, value: trace },
      // Written after the run record, so feedback that finds the index always finds the run too.
      { collection: RESPONSES_COLLECTION, key: responseId, value: responseIndex },
      ...feedback.map(collected => agentFeedbackRecord({ meta, collected, captureContent })),
    ],
  });
}
