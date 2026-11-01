import type { GroupLesson } from '../learning/lessons.js';
import { CORRECTION_CONFIDENCE } from '../memory/corrections.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { ResolvedMemoryOptions } from '../memory/memory-types.js';

export interface SaveGroupLessonParams {
  memory: MemoryStore;
  /** The agent's memory options in this runtime; undefined when its memory is off. */
  options: ResolvedMemoryOptions | undefined;
  agentName: string;
  lesson: GroupLesson;
}

/**
 * Saves a group lesson as a `lesson` memory in the scope its rated runs used (scrubbed, redacted and deduplicated by
 * the memory store like any note). Resolves with why it was not saved, or undefined when it was.
 */
export async function saveGroupLesson(params: SaveGroupLessonParams): Promise<string | undefined> {
  const { memory, options, agentName, lesson: { scopeKey, note, runIds } } = params;
  const [runId] = runIds;
  if (options == null) return `Agent '${agentName}' has no memory in this runtime, so its lesson for '${params.lesson.groupId}' was not saved`;
  if (runId == null) return `Lesson '${params.lesson.groupId}' has no rated runs`;
  const result = await memory.save({ options, request: { agentName, scopeKey, notes: [note], source: { runId, origin: 'user-correction' }, confidence: CORRECTION_CONFIDENCE } });
  return result.saved === 1 ? undefined : result.problems.join('; ');
}
