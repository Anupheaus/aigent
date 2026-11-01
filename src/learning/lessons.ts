import { groupSimilarTasks } from '../analysis/trace-group.js';
import type { UserFeedback } from '../feedback/feedback-records.js';
import { MAX_MEMORY_TAGS, MAX_MEMORY_TAG_LENGTH, MAX_MEMORY_TEXT_LENGTH } from '../memory/memory-schema.js';
import type { MemoryNote } from '../memory/memory-types.js';
import { contentTerms } from '../memory/stop-words.js';
import type { RunTrace } from '../telemetry/run-record.js';

/** Corrections of similar tasks needed before they make a group lesson (one is the per-rating lesson's job). */
export const MIN_GROUP_CORRECTIONS = 2;
const MAX_EXCERPT_LENGTH = 80;
const MAX_ANSWERS_QUOTED = 3;
const MAX_ANSWER_LENGTH = 120;
const MIN_TAG_LENGTH = 3;
const SESSION_SCOPE_PREFIX = 'session:';
const ELLIPSIS = '…';

/** A lesson for one scope: what users said the answers to similar tasks should have been. */
export interface GroupLesson {
  /** The memory scope the rated runs used: the lesson is saved there only. */
  scopeKey: string;
  groupId: string;
  note: MemoryNote;
  /** The rated runs it comes from, sorted. */
  runIds: string[];
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

function tagsOf(task: string): string[] {
  return [...new Set(contentTerms(task).filter(word => word.length >= MIN_TAG_LENGTH && word.length <= MAX_MEMORY_TAG_LENGTH))].slice(0, MAX_MEMORY_TAGS);
}

/**
 * Lessons from groups of similar tasks (the analysis grouping) that users rated incorrect at least
 * `MIN_GROUP_CORRECTIONS` times with an expected answer. Grouped per memory scope, so a lesson never crosses scopes, and
 * built from fixed text plus the users' expected answers (the memory store scrubs and redacts them when it saves).
 * Pure: no model call.
 */
export function buildGroupLessons(params: { traces: RunTrace[]; ratings: Map<string, UserFeedback> }): GroupLesson[] {
  const { traces, ratings } = params;
  // A task in session scope is its own session: no later run reads that scope, so a lesson there would only be stored.
  const corrected = traces.filter(({ run }) => run.userVerdict === 'incorrect' && run.task != null && run.memoryScopeKey != null && run.memoryScopeKey !== `${SESSION_SCOPE_PREFIX}${run.runId}`
    && (ratings.get(run.responseId)?.expectedAnswer?.trim() ?? '') !== '');
  const scopes = [...new Set(corrected.map(({ run }) => run.memoryScopeKey as string))].sort();
  return scopes.flatMap(scopeKey => groupSimilarTasks(corrected.filter(({ run }) => run.memoryScopeKey === scopeKey)).flatMap(group => {
    if (group.traces.length < MIN_GROUP_CORRECTIONS) return [];
    const answers = [...new Set(group.traces.map(({ run }) => cut(ratings.get(run.responseId)?.expectedAnswer ?? '', MAX_ANSWER_LENGTH)))].slice(0, MAX_ANSWERS_QUOTED);
    const text = cut(`Similar tasks ("${cut(group.sampleTask, MAX_EXCERPT_LENGTH)}") were answered incorrectly ${group.traces.length} times; users expected: ${answers.join('; ')}`, MAX_MEMORY_TEXT_LENGTH);
    return [{ scopeKey, groupId: group.groupId, note: { kind: 'lesson', text, tags: tagsOf(group.sampleTask) }, runIds: group.traces.map(({ run }) => run.runId).sort() }];
  }));
}
