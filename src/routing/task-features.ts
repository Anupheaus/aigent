import type { TaskInput } from '../core/task-input.js';
import type { KeywordClass, LengthBucket, TaskFeatures } from './routing-types.js';

/** Characters (task plus context) below which a task is short, then medium. */
const SHORT_MAX_CHARS = 200;
const MEDIUM_MAX_CHARS = 1_000;
const GENERAL_BUCKET = 'general';

/** Whole words (lowercase) that name each kind of work. Small and fixed, so features are deterministic. */
const LEXICON: Record<KeywordClass, readonly string[]> = {
  search: ['find', 'search', 'locate', 'where', 'look', 'lookup', 'grep'],
  edit: ['edit', 'change', 'fix', 'update', 'rename', 'refactor', 'add', 'remove', 'write', 'replace', 'delete'],
  analyse: ['analyse', 'analyze', 'why', 'explain', 'compare', 'review', 'investigate', 'debug', 'diagnose'],
  summarise: ['summarise', 'summarize', 'summary', 'tl;dr', 'tldr', 'overview', 'recap'],
};

const KEYWORD_CLASSES = Object.keys(LEXICON).sort() as KeywordClass[];
/** Letters, digits and the `;` of "tl;dr"; anything else separates words. */
const WORD_SEPARATOR = /[^a-z0-9;]+/;

function lengthBucket(chars: number): LengthBucket {
  if (chars < SHORT_MAX_CHARS) return 'short';
  return chars < MEDIUM_MAX_CHARS ? 'medium' : 'long';
}

function keywordClassesOf(text: string): KeywordClass[] {
  const words = new Set(text.toLowerCase().split(WORD_SEPARATOR));
  return KEYWORD_CLASSES.filter(keywordClass => LEXICON[keywordClass].some(word => words.has(word)));
}

/** The task's routing features: sizes, flags and kinds of work, from the input alone (no model call). */
export function extractTaskFeatures(input: TaskInput, toolCount = 0): TaskFeatures {
  const { task, context = '', plan, acceptanceCriteria = [], output, unattended = false, label } = input;
  return {
    length: lengthBucket(task.length + context.length),
    hasPlan: plan != null && plan.length > 0,
    acceptanceCriteria: acceptanceCriteria.length,
    hasOutputSchema: output != null,
    toolCount,
    unattended,
    ...(label == null ? {} : { label }),
    keywordClasses: keywordClassesOf(task),
  };
}

/**
 * The statistics bucket of a task: its length and kinds of work. Coarse on purpose, so a bucket collects enough runs
 * to learn from; the other features are recorded but not bucketed.
 */
export function featureBucket(features: TaskFeatures): string {
  const { length, keywordClasses } = features;
  return `${length}:${keywordClasses.length === 0 ? GENERAL_BUCKET : keywordClasses.join('+')}`;
}
