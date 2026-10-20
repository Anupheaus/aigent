import { createContextMessage } from '../context/context-message.js';
import type { ContextMessage } from '../context/context-message.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { createRecordWriter } from '../telemetry/record-writer.js';
import type { Redact } from '../telemetry/redact.js';
import { createCheckpointWriter } from './checkpoint-writer.js';
import { createFencedStore } from './fencing-store.js';
import type { CheckpointWriter, CheckpointWriterOptions } from './checkpoint-writer.js';
import type { RunState } from './checkpoint-types.js';

/** A store that counts reads, for restore-cost assertions. */
export function countingStore(store: Store = createInMemoryStore()): { store: Store; reads(): number } {
  let reads = 0;
  return {
    store: { ...store, get: (collection, key) => { reads += 1; return store.get(collection, key); }, list: collection => { reads += 1; return store.list(collection); } },
    reads: () => reads,
  };
}

/** A run state whose context holds `messages`. */
export function runState(messages: ContextMessage[], overrides: Partial<RunState> = {}): RunState {
  return {
    kind: 'run', runId: 'run1', agentName: 'a', agentVersion: 'v', mode: 'task', status: 'running', input: { task: 't' },
    context: { messages, ratio: 1, peakTokens: 0, volatileTokens: 0, created: messages.length },
    totals: { usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, turns: 0, toolCalls: 0, retries: 0, fallbacks: 0, compactionTokens: 0 },
    planning: { plan: [], todo: [], nextTodoNumber: 1 }, originals: [], hasResultOriginal: false, approvals: [],
    ...overrides,
  };
}

/** The n-th test message (`text` defaults to its number). */
export function message(seq: number, text = `m${seq}`): ContextMessage {
  return createContextMessage({ runId: 'run1', seq, kind: 'user', createdAt: seq, message: { role: 'user', text } });
}

export interface CheckpointHarnessParams {
  store?: Store;
  options?: CheckpointWriterOptions;
  redact?: Redact;
  fence?: number;
}

/** A run stream's writer over `store`, through the record writer (queue and redact) like the runtime's. */
export function checkpointHarness(params: CheckpointHarnessParams = {}): { store: Store; writer: CheckpointWriter } {
  const { store = createInMemoryStore(), options, redact, fence = 1 } = params;
  const fenced = createFencedStore({ store, instanceId: 'inst', fence: () => fence });
  const records = createRecordWriter({ store: fenced, writeQueue: createWriteQueue(), ...(redact == null ? {} : { redact }) });
  const writer = createCheckpointWriter({ records, store: fenced, instanceId: 'inst', stream: { kind: 'run', id: 'run1' }, fence: () => fence, clock: { now: () => 5 }, ...(options == null ? {} : { options }) });
  return { store, writer };
}
