import { createAigentError } from '../core/aigent-error.js';
import type { Store } from '../store/store-types.js';
import { RUNS_COLLECTION } from '../telemetry/collections.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import type { RecordMeta, RunRecord } from '../telemetry/run-record.js';
import { parseResponseIndex } from '../telemetry/run-record-schema.js';
import { FEEDBACK_COLLECTION, RESPONSES_COLLECTION, USER_RATINGS } from './feedback-records.js';
import type { ResponseIndexRecord, UserFeedback, UserFeedbackHistoryEntry, UserFeedbackRecord, UserRating } from './feedback-records.js';
import { parseUserFeedback } from './user-feedback-schema.js';

export interface RecordUserFeedbackParams {
  store?: Store;
  /** Present whenever there is a store: every write goes through redact and the agent's queue. */
  writer?: RecordWriter;
  now(): number;
  /** False stores the lengths of `comment` and `expectedAnswer`, never their text. */
  captureContent: boolean;
  /** Validated here: it comes straight from the consumer. */
  feedback: unknown;
  /** Called once the rating is stored, with the rated run (e.g. to turn a correction into a memory lesson). */
  onRated?(params: RatedRun): Promise<void>;
}

/** A stored rating and the run it is about. */
export interface RatedRun {
  run: RunRecord;
  feedback: UserFeedback;
}

/** The new content of one rating: the only part of the feedback record that passes through redact. */
type UserFeedbackPatch = Pick<UserFeedbackRecord, 'rating' | 'comment' | 'commentLength' | 'expectedAnswer' | 'expectedAnswerLength'> & {
  entry: UserFeedbackHistoryEntry;
};

/** The verdict copied onto the run record. */
type RunVerdictPatch = Pick<RunRecord, 'userVerdict'>;

function invalid(message: string, details: Record<string, unknown>): Error {
  return createAigentError({ code: 'invalid_input', message, details });
}

/** The run identity copied from the index, so the feedback record can be sliced and purged like the run's own records. */
function metaOf(index: ResponseIndexRecord, recordedAt: number): RecordMeta {
  const { schemaVersion, runId, agentName, instanceId, mode, agentVersion, scope, expiresAt } = index;
  return { schemaVersion, runId, agentName, instanceId, mode, agentVersion, ...(scope == null ? {} : { scope }), recordedAt, ...(expiresAt == null ? {} : { expiresAt }) };
}

/** The new rating's fields; with content capture off, text fields are stored as their lengths. */
function patchOf(params: { feedback: UserFeedback; at: number; captureContent: boolean }): UserFeedbackPatch {
  const { feedback: { rating, comment, expectedAnswer }, at, captureContent } = params;
  const commentField = comment == null ? {} : captureContent ? { comment } : { commentLength: comment.length };
  const expectedAnswerField = expectedAnswer == null ? {} : captureContent ? { expectedAnswer } : { expectedAnswerLength: expectedAnswer.length };
  return { rating, ...commentField, ...expectedAnswerField, entry: { at, rating, ...commentField } };
}

/** The latest rating replaces the current fields; every rating stays in `history` (stored entries are kept as they are). */
function mergeFeedback(params: { index: ResponseIndexRecord; current: UserFeedbackRecord | undefined; patch: UserFeedbackPatch }): UserFeedbackRecord {
  const { index, current, patch: { entry, ...fields } } = params;
  return { ...metaOf(index, entry.at), kind: 'user', responseId: index.responseId, ...fields, history: [...current?.history ?? [], entry] };
}

async function findResponse(params: { store: Store; responseId: string }): Promise<ResponseIndexRecord> {
  const { store, responseId } = params;
  const stored = await store.get(RESPONSES_COLLECTION, responseId);
  if (stored == null) {
    throw invalid(`Unknown responseId '${responseId}': no stored run has it (runs with disableTelemetry, runs made without a store and purged runs are not stored)`, { responseId });
  }
  return parseResponseIndex({ collection: RESPONSES_COLLECTION, key: responseId, value: stored.value });
}

function isUserRating(value: unknown): value is UserRating {
  return (USER_RATINGS as readonly unknown[]).includes(value);
}

/**
 * The verdict is read from the stored feedback record inside the run update (after the run is read, before its
 * compare-and-set), so whichever rating's run update lands last copies the latest stored rating, never its own stale one.
 */
async function latestRating(params: { store: Store; responseId: string; fallback: UserRating }): Promise<UserRating> {
  const { store, responseId, fallback } = params;
  const rating = (await store.get<UserFeedbackRecord>(FEEDBACK_COLLECTION, responseId))?.value.rating;
  return isUserRating(rating) ? rating : fallback;
}

/**
 * Validates and stores a user's rating of a response (amending any earlier one, keeping its history) and copies the
 * latest stored rating onto the run record as `userVerdict`. Works on any runtime sharing the store, long after the run.
 */
export async function recordUserFeedback(params: RecordUserFeedbackParams): Promise<void> {
  const { store, writer, now, captureContent, onRated } = params;
  const feedback = parseUserFeedback(params.feedback);
  const { responseId, rating } = feedback;
  if (store == null || writer == null) throw invalid(`Cannot record feedback on '${responseId}': createAigent was given no store, so no response was stored`, { responseId });
  const index = await findResponse({ store, responseId });
  const { runId, agentName } = index;
  const patch = patchOf({ feedback, at: now(), captureContent });
  await writer.update<UserFeedbackRecord, UserFeedbackPatch>({
    queueKey: agentName, collection: FEEDBACK_COLLECTION, key: responseId,
    patch: () => patch,
    merge: ({ current, patch: redacted }) => mergeFeedback({ index, current, patch: redacted }),
  });
  // A purged run keeps no record to mark; the feedback itself is still stored.
  if (await store.get(RUNS_COLLECTION, runId) == null) return;
  const run = await writer.update<RunRecord, RunVerdictPatch>({
    queueKey: agentName, collection: RUNS_COLLECTION, key: runId,
    patch: async current => {
      if (current == null) throw invalid(`Run '${runId}' of response '${responseId}' was removed while its feedback was being recorded`, { runId, responseId });
      return { userVerdict: await latestRating({ store, responseId, fallback: rating }) };
    },
    merge: ({ current, patch: redacted }) => ({ ...current as RunRecord, ...redacted }),
  });
  await onRated?.({ run, feedback });
}
