import { withFeedbackFields } from '../feedback/with-feedback-fields.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { MemoryRetriever } from '../memory/memory-types.js';
import { createMemoryTools } from '../memory/memory-tools.js';
import type { MemoryToolAccess } from '../memory/memory-tools.js';
import { interfaceKeyOf, memoryScopeKey } from '../memory/scope-key.js';
import { withMemoryField } from '../memory/with-memory-field.js';
import type { TraceRecorder } from '../telemetry/trace-recorder.js';
import type { Tool } from '../tools/tool-types.js';
import type { AigentEvent } from './aigent-events.js';
import { createRunMemory } from './run-memory.js';
import type { RunMemory } from './run-memory.js';
import { createRunRecall, recallQueryOf } from './run-recall.js';
import { renderRecall } from '../memory/render-recall.js';
import { createAigentError } from './aigent-error.js';
import type { RunRecall } from './run-recall.js';
import type { ResolvedAgent } from './start-task-run.js';
import type { TaskInput } from './task-input.js';

/** A run's memory: saving from the `memory` field, recall into the volatile block, and the memory tools. */
export interface RunMemorySetup {
  memory: RunMemory;
  recall: RunRecall;
  /** `memory_recall` and `memory_forget`, with the same fields as the agent's other tools. */
  tools: Tool[];
}

export interface SetUpRunMemoryParams {
  agent: Pick<ResolvedAgent, 'name' | 'memory' | 'memoryRetriever' | 'feedbackCollector'>;
  store?: MemoryStore;
  input: TaskInput;
  runId: string;
  /** The chat session, for a chat turn. */
  sessionId?: string;
  recorder: Pick<TraceRecorder, 'noteMemory'>;
  emit(event: AigentEvent): void;
}

/** The memory tools as the agent's registry would hold them: `memory` (and `previous`, with feedback on) added. */
export function memoryToolsFor(params: { agent: SetUpRunMemoryParams['agent']; access: MemoryToolAccess }): Tool[] {
  const { agent: { memory, feedbackCollector }, access } = params;
  if (memory == null) return [];
  return createMemoryTools(access).map(tool => withMemoryField({ tool: feedbackCollector == null ? tool : withFeedbackFields(tool), maxPerCall: memory.maxPerCall }));
}

/** Tools for a preview: never run, so their access refuses rather than reaching the store. */
const PREVIEW_ACCESS: MemoryToolAccess = {
  recall: async () => { throw createAigentError({ code: 'invalid_input', message: 'Memory tools do not run in a preview' }); },
  forget: async () => { throw createAigentError({ code: 'invalid_input', message: 'Memory tools do not run in a preview' }); },
};

export interface PreviewMemoryParams {
  agent: SetUpRunMemoryParams['agent'];
  store?: MemoryStore;
  input?: TaskInput;
}

/** What `agent.preview` adds for memory: the tools, and the section a run of `input` would start with (no use counted). */
export async function previewMemory(params: PreviewMemoryParams): Promise<{ tools: Tool[]; section?: string }> {
  const { agent, store, input } = params;
  const tools = memoryToolsFor({ agent, access: PREVIEW_ACCESS });
  const { name: agentName, memory: options, memoryRetriever: retriever } = agent;
  if (options == null || store == null || input == null) return { tools };
  const interfaceKey = interfaceKeyOf(input);
  // A preview has no run and no session: agent scope reads the shared memories; the others have nothing to show yet.
  if (options.scope === 'session' || (options.scope === 'interface' && interfaceKey == null)) return { tools };
  const scopeKey = memoryScopeKey({ scope: options.scope, runId: 'preview', ...(interfaceKey == null ? {} : { interfaceKey }) });
  // A preview changes nothing: the retriever's read-only ranking when it has one.
  const previewRetriever: MemoryRetriever | undefined = retriever?.preview == null ? retriever : { rank: retriever.preview };
  const { memories } = await store.recall({
    agentName, scopeKey, query: recallQueryOf(input), limit: options.recallLimit, halfLifeDays: options.halfLifeDays, minConfidence: options.minConfidence, markUsed: false,
    ...(previewRetriever == null ? {} : { retriever: previewRetriever }),
  });
  const section = renderRecall(memories);
  return { tools, ...(section == null ? {} : { section: `## ${section.title}\n${section.body}` }) };
}

/**
 * The run's memory, or undefined when the agent has none. Throws `invalid_input` (synchronously, from `agent.task`)
 * for interface scope without a key. Dry runs and `disableTelemetry` runs (evals, tests) read memory but write none:
 * no notes and no use counters.
 */
export function setUpRunMemory(params: SetUpRunMemoryParams): RunMemorySetup | undefined {
  const { agent, store, input, runId, sessionId, recorder, emit } = params;
  const { name: agentName, memory: options, memoryRetriever: retriever } = agent;
  if (options == null || store == null) return undefined;
  const interfaceKey = interfaceKeyOf(input);
  const scopeKey = memoryScopeKey({ scope: options.scope, runId, ...(sessionId == null ? {} : { sessionId }), ...(interfaceKey == null ? {} : { interfaceKey }) });
  const skipReason = input.dryRun === true ? 'this run is a dry run, which changes nothing'
    : input.disableTelemetry === true ? 'this run has disableTelemetry, which writes nothing to the store' : undefined;
  const memory = createRunMemory({ store, options, agentName, runId, scopeKey, recorder, emit, ...(skipReason == null ? {} : { skipReason }) });
  const recall = createRunRecall({
    store, agentName, scopeKey, options, emit, markUsed: skipReason == null, track: work => memory.track(work),
    ...(retriever == null ? {} : { retriever }),
  });
  return { memory, recall, tools: memoryToolsFor({ agent, access: recall.access }) };
}
