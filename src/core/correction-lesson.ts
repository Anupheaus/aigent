import type { RatedRun } from '../feedback/user-feedback.js';
import { CORRECTION_CONFIDENCE, lessonFromCorrection } from '../memory/corrections.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { ResolvedMemoryOptions } from '../memory/memory-types.js';
import { createAigentError } from './aigent-error.js';

export interface SaveCorrectionLessonParams {
  memory: MemoryStore;
  /** The memory options of the rated run's agent, when this runtime knows it (else the runtime default). */
  optionsFor(agentName: string): ResolvedMemoryOptions | undefined;
  rated: RatedRun;
}

/**
 * Saves the lesson of an `incorrect` or `partial` rating as a `lesson` memory of the rated run's agent, in the scope
 * that run used (so it is recalled for similar tasks there), deduplicated like any note. Nothing happens for runs
 * made without memory. Throws `store_failed` when the lesson could not be written, after the rating itself is stored.
 */
export async function saveCorrectionLesson(params: SaveCorrectionLessonParams): Promise<void> {
  const { memory, optionsFor, rated: { run: { agentName, runId, responseId, task, memoryScopeKey }, feedback } } = params;
  if (memoryScopeKey == null) return;
  const options = optionsFor(agentName);
  const note = lessonFromCorrection({ feedback, ...(task == null ? {} : { task }) });
  if (options == null || note == null) return;
  const result = await memory.save({ options, request: { agentName, scopeKey: memoryScopeKey, notes: [note], source: { runId, origin: 'user-correction' }, confidence: CORRECTION_CONFIDENCE } });
  if (result.saved === 1) return;
  throw createAigentError({
    code: 'store_failed',
    message: `Feedback on '${responseId}' was stored, but its lesson was not saved to memory: ${result.problems.join('; ')}`,
    details: { responseId, runId, agentName },
  });
}
