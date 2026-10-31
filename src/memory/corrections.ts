import type { UserFeedback } from '../feedback/feedback-records.js';
import { contentTerms } from './stop-words.js';
import { MAX_MEMORY_TAG_LENGTH, MAX_MEMORY_TAGS, MAX_MEMORY_TEXT_LENGTH } from './memory-schema.js';
import type { MemoryNote } from './memory-types.js';

/** Where a correction's lesson starts: higher than a note the agent wrote itself (0.6). */
export const CORRECTION_CONFIDENCE = 0.8;
/** Longest task excerpt a lesson quotes. */
const MAX_TASK_EXCERPT = 80;
const ELLIPSIS = '…';
/** Shortest word kept as a tag. */
const MIN_TAG_LENGTH = 3;

function cut(params: { text: string; max: number }): string {
  const { text, max } = params;
  return text.length <= max ? text : `${text.slice(0, max - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

/** The task's distinctive words, so recall for a similar task finds the lesson. */
function taskTags(task: string): string[] {
  const words = contentTerms(task).filter(word => word.length >= MIN_TAG_LENGTH && word.length <= MAX_MEMORY_TAG_LENGTH);
  return [...new Set(words)].slice(0, MAX_MEMORY_TAGS);
}

export interface LessonFromCorrectionParams {
  feedback: UserFeedback;
  /** The rated run's task text, when it was stored. */
  task?: string;
}

/**
 * The lesson a user's correction teaches (`incorrect` or `partial` with an expected answer or a comment), quoting the
 * task so it is recalled for similar tasks; undefined when there is nothing to learn.
 */
export function lessonFromCorrection(params: LessonFromCorrectionParams): MemoryNote | undefined {
  const { feedback: { rating, expectedAnswer, comment }, task } = params;
  if (rating === 'correct') return undefined;
  const correction = expectedAnswer != null && expectedAnswer !== ''
    ? `the right answer was ${expectedAnswer}${comment == null || comment === '' ? '' : ` (${comment})`}`
    : comment;
  if (correction == null || correction === '') return undefined;
  const excerpt = task == null ? '' : cut({ text: task.replace(/\s+/g, ' ').trim(), max: MAX_TASK_EXCERPT });
  const text = excerpt === '' ? correction : `For "${excerpt}": ${correction}`;
  return { kind: 'lesson', text: cut({ text, max: MAX_MEMORY_TEXT_LENGTH }), tags: task == null ? [] : taskTags(task) };
}
