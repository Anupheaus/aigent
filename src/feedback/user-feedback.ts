import { createAigentError } from '../core/aigent-error.js';
import type { Store } from '../store/store-types.js';
import { RUNS_COLLECTION } from '../telemetry/collections.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import type { RecordMeta, RunRecord } from '../telemetry/run-record.js';
import { parseResponseIndex } from '../telemetry/run-record-schema.js';
import { FEEDBACK_COLLECTION, RESPONSES_COLLECTION } from './feedback-records.js';
import type { ResponseIndexRecord, UserFeedback, UserFeedbackHistoryEntry, UserFeedbackRecord } from './feedback-records.js';
import { parseUserFeedback } from './user-feedback-schema.js';

export interface RecordUserFeedbackParams {
  store?: Store;
  /** Present whenever there is a store: every write goes through redact and the agent's queue. */
  writer?: RecordWriter;
  now(): number;
  /** Validated here: it comes straight from the consumer. */
  feedback: unknown;
}

interface NextFeedbackParams {
  index: ResponseIndexRecord;
  feedback: UserFeedback;
  entry: UserFeedbackHistoryEntry;
  current?: UserFeedbackRecord;
}

function invalid(message: string, details: Record<string, unknown>): Error {
  return createAigentError({ code: 'invalid_input', message, details });
}

/** The run identity copied from the index, so the feedback record can be sliced and purged like the run's own records. */
function metaOf(index: ResponseIndexRecord, recordedAt: number): RecordMeta {
  const { schemaVersion, runId, agentName, instanceId, mode, agentVersion, scope, expiresAt } = index;
  return { schemaVersion, runId, agentName, instanceId, mode, agentVersion, ...(scope == null ? {} : { scope }), recordedAt, ...(expiresAt == null ? {} : { expiresAt }) };
}

/** The latest rating replaces the current fields; every rating stays in `history`. */
function nextFeedback(params: NextFeedbackParams): UserFeedbackRecord {
  const { index, feedback: { responseId, rating, comment, expectedAnswer }, entry, current } = params;
  return {
    ...metaOf(index, entry.at), kind: 'user', responseId, rating,
    ...(comment == null ? {} : { comment }),
    ...(expectedAnswer == null ? {} : { expectedAnswer }),
    history: [...current?.history ?? [], entry],
  };
}

async function findResponse(params: { store: Store; responseId: string }): Promise<ResponseIndexRecord> {
  const { store, responseId } = params;
  const stored = await store.get(RESPONSES_COLLECTION, responseId);
  if (stored == null) {
    throw invalid(`Unknown responseId '${responseId}': no stored run has it (runs with disableTelemetry, runs made without a store and purged runs are not stored)`, { responseId });
  }
  return parseResponseIndex({ collection: RESPONSES_COLLECTION, key: responseId, value: stored.value });
}

/**
 * Validates and stores a user's rating of a response (amending any earlier one, keeping its history) and copies the
 * verdict onto the run record as `userVerdict`. Works on any runtime sharing the store, long after the run.
 */
export async function recordUserFeedback(params: RecordUserFeedbackParams): Promise<void> {
  const { store, writer, now } = params;
  const feedback = parseUserFeedback(params.feedback);
  const { responseId, rating, comment } = feedback;
  if (store == null || writer == null) throw invalid(`Cannot record feedback on '${responseId}': createAigent was given no store, so no response was stored`, { responseId });
  const index = await findResponse({ store, responseId });
  const { runId, agentName } = index;
  const entry: UserFeedbackHistoryEntry = { at: now(), rating, ...(comment == null ? {} : { comment }) };
  await writer.update<UserFeedbackRecord>({
    queueKey: agentName, collection: FEEDBACK_COLLECTION, key: responseId,
    update: current => nextFeedback({ index, feedback, entry, ...(current == null ? {} : { current }) }),
  });
  // A purged run keeps no record to mark; the feedback itself is still stored.
  if (await store.get(RUNS_COLLECTION, runId) == null) return;
  await writer.update<RunRecord>({
    queueKey: agentName, collection: RUNS_COLLECTION, key: runId,
    update: current => {
      if (current == null) throw invalid(`Run '${runId}' of response '${responseId}' was removed while its feedback was being recorded`, { runId, responseId });
      return { ...current, userVerdict: rating };
    },
  });
}
