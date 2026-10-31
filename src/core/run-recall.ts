import type { VolatileSection } from '../context/volatile-block.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { MemoryToolAccess } from '../memory/memory-tools.js';
import type { MemoryRetriever, RecalledMemory, ResolvedMemoryOptions } from '../memory/memory-types.js';
import { renderRecall } from '../memory/render-recall.js';
import type { PlanItem } from '../planning/plan-schema.js';
import type { AigentEvent } from './aigent-events.js';
import { describeError } from './describe-value.js';
import type { TaskInput } from './task-input.js';

/** One run's recalled memories: chosen at run start, extended by `memory_recall`, shown in the volatile block. */
export interface RunRecall {
  /** Recalls for the run's query; the section shows them from the first request on. */
  start(query: string): Promise<void>;
  /** The `Remembered from earlier` section, when there is anything to show. */
  extras(): VolatileSection[];
  /** What `memory_recall` and `memory_forget` reach. */
  access: MemoryToolAccess;
}

export interface CreateRunRecallParams {
  store: MemoryStore;
  agentName: string;
  scopeKey: string;
  options: ResolvedMemoryOptions;
  retriever?: MemoryRetriever;
  /** False reads without counting uses (dry runs, telemetry off). */
  markUsed: boolean;
  /** Holds the queued use counters, so the run waits for them before its result. */
  track(work: Promise<void>): void;
  emit(event: AigentEvent): void;
}

/** What a run recalls with: the task and its plan labels (a chat turn's task is the user's message). */
export function recallQueryOf(input: Pick<TaskInput, 'task'> & { plan?: Pick<PlanItem, 'label'>[] }): string {
  return [input.task, ...(input.plan ?? []).map(({ label }) => label)].join('\n');
}

export function createRunRecall(params: CreateRunRecallParams): RunRecall {
  const { store, agentName, scopeKey, options: { recallLimit, halfLifeDays, minConfidence }, retriever, markUsed, track, emit } = params;
  let shown: RecalledMemory[] = [];
  const onProblem = (message: string): void => emit({ type: 'warning', message });

  async function recall(recallParams: { query: string; limit: number }): Promise<RecalledMemory[]> {
    const { query, limit } = recallParams;
    const { memories, used } = await store.recall({ agentName, scopeKey, query, limit, halfLifeDays, minConfidence, onProblem, markUsed, ...(retriever == null ? {} : { retriever }) });
    track(used);
    return memories;
  }

  /** New memories join after those already shown, so the section only grows (until forgotten). */
  function show(memories: RecalledMemory[]): void {
    const known = new Set(shown.map(({ id }) => id));
    shown = [...shown, ...memories.filter(({ id }) => !known.has(id))];
  }

  return {
    start: async query => {
      try {
        show(await recall({ query, limit: recallLimit }));
      } catch (error) {
        // The run goes on without memories rather than failing because the store could not be read.
        onProblem(`Memories were not recalled: ${describeError(error)}`);
      }
    },
    extras: () => {
      const section = renderRecall(shown);
      return section == null ? [] : [section];
    },
    access: {
      recall: async recallParams => {
        const memories = await recall(recallParams);
        show(memories);
        return memories;
      },
      forget: async ids => {
        const result = await store.forget({ agentName, scopeKey, ids });
        const forgotten = new Set(result.forgotten);
        shown = shown.filter(({ id }) => !forgotten.has(id));
        return result;
      },
    },
  };
}
