import { createHash } from 'node:crypto';
import { compareRunOrder } from '../scoring/baseline.js';
import type { RunTrace } from '../telemetry/run-record.js';

/** Runs whose tasks are similar enough to be "the same request". */
export interface TaskGroup {
  /** `task:<hash>` for text-similar tasks, `label:<label>` or `run:<runId>` without task text. */
  groupId: string;
  /** The first run's task text, the label for label groups, `''` otherwise. */
  sampleTask: string;
  /** In start order. */
  traces: RunTrace[];
}

export interface GroupSimilarTasksOptions {
  /** Least token-set Jaccard similarity to the group's first task (default 0.6). */
  threshold: number;
}

const DEFAULT_SIMILARITY = 0.6;
const GROUP_ID_HASH_LENGTH = 12;
/** Placeholder every number becomes, so "issue 12" and "issue 3401" read the same. */
const NUMBER_TOKEN = '#';
/** Words that say nothing about what was asked. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'was', 'be', 'which', 'that', 'this', 'it', 'with', 'by', 'at',
  'from', 'as', 'what', 'where', 'how', 'please', 'me', 'my', 'i', 'you', 'can', 'could', 'would', 'should', 'do', 'does',
]);

/** Distinct meaningful words of a task, in first-appearance order: lowercase, no punctuation or stopwords, numbers as `#`. */
export function normaliseTask(task: string): string[] {
  const words = task.toLowerCase()
    .replace(/\d+/g, ` ${NUMBER_TOKEN} `)
    .replace(/[^\p{L}#\s]/gu, ' ')
    .split(/\s+/)
    .filter(word => word !== '' && !STOPWORDS.has(word));
  return [...new Set(words)];
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  const shared = [...left].filter(word => right.has(word)).length;
  return shared / (left.size + right.size - shared);
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, GROUP_ID_HASH_LENGTH);
}

interface OpenGroup {
  group: TaskGroup;
  words?: Set<string>;
}

/** Where a run without task text goes: its label's group, or one of its own. */
function fallbackKey(trace: RunTrace): { groupId: string; sampleTask: string } {
  const { run: { label, runId } } = trace;
  return label == null ? { groupId: `run:${runId}`, sampleTask: '' } : { groupId: `label:${label}`, sampleTask: label };
}

/**
 * Clusters runs into requests. Runs are taken in start order; each joins the first group whose first task is at least
 * `threshold` similar (token-set Jaccard), or starts a new one. Runs without stored task text group by label, else alone.
 * Deterministic: input order never matters.
 */
export function groupSimilarTasks(traces: RunTrace[], options: GroupSimilarTasksOptions = { threshold: DEFAULT_SIMILARITY }): TaskGroup[] {
  const { threshold } = options;
  // All groups in creation order (the output order); label and lone-run groups are also indexed by id, and only text
  // groups are compared for similarity, so runs without task text cost O(1) each instead of a scan of every group.
  const groups: TaskGroup[] = [];
  const fallbackGroups = new Map<string, TaskGroup>();
  const textGroups: OpenGroup[] = [];
  const sorted = [...traces].sort((left, right) => compareRunOrder(left.run, right.run));
  for (const trace of sorted) {
    const { run: { task } } = trace;
    if (task == null) {
      const { groupId, sampleTask } = fallbackKey(trace);
      const existing = fallbackGroups.get(groupId);
      if (existing != null) { existing.traces.push(trace); continue; }
      const group = { groupId, sampleTask, traces: [trace] };
      fallbackGroups.set(groupId, group);
      groups.push(group);
      continue;
    }
    const words = new Set(normaliseTask(task));
    const similar = textGroups.find(open => open.words != null && jaccard(open.words, words) >= threshold);
    if (similar != null) { similar.group.traces.push(trace); continue; }
    const group = { groupId: `task:${hashOf([...words].join(' '))}`, sampleTask: task, traces: [trace] };
    textGroups.push({ group, words });
    groups.push(group);
  }
  return groups;
}
