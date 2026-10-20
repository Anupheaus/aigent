import type { Agent, AgentDefinition, TaskResult } from '../core/agent-types.js';
import type { TaskStatus } from '../core/aigent-events.js';
import type { TaskInput } from '../core/task-input.js';
import type { Compressor } from './compressor-types.js';

/** One side of an A/B comparison. */
export interface CompressionEvalSide {
  status: TaskStatus;
  answer: string;
  inputTokens: number;
  durationMs: number;
  /** Final plan statuses, when the task had a plan. */
  plan?: { id: string; status: string }[];
}

/** One task run without and with compression. */
export interface CompressionEvalResult {
  task: string;
  baseline: CompressionEvalSide;
  compressed: CompressionEvalSide;
  isSameStatus: boolean;
  isSameAnswer: boolean;
  /** The plan's items (the task's acceptance criteria) ended with the same statuses; true without a plan. */
  isSameCriteria: boolean;
  /** Input tokens the compressed run saved (negative when it used more). */
  tokensSaved: number;
  /** Extra wall time of the compressed run (negative when faster). */
  latencyMs: number;
}

/** `ai.evalCompression`: every task's comparison and the totals. */
export interface CompressionEvalReport {
  results: CompressionEvalResult[];
  summary: { tasks: number; sameStatus: number; sameAnswer: number; sameCriteria: number; tokensSaved: number; latencyMs: number };
}

export interface EvalCompressionParams {
  /** Builds an agent from a definition (`ai.agent`). */
  createAgent(definition: AgentDefinition): Agent;
  /** The agent to evaluate; its own `compression` is replaced by `compressor` for the compressed side and removed for the baseline. */
  agent: AgentDefinition;
  tasks: TaskInput[];
  compressor: Compressor;
}

function toSide(result: TaskResult): CompressionEvalSide {
  const { status, answer, usage: { inputTokens, durationMs }, plan } = result;
  return { status, answer, inputTokens, durationMs, ...(plan == null ? {} : { plan: plan.map(({ id, status: itemStatus }) => ({ id, status: itemStatus })) }) };
}

function compare(params: { task: string; baseline: CompressionEvalSide; compressed: CompressionEvalSide }): CompressionEvalResult {
  const { task, baseline, compressed } = params;
  return {
    task, baseline, compressed,
    isSameStatus: baseline.status === compressed.status,
    isSameAnswer: baseline.answer === compressed.answer,
    isSameCriteria: JSON.stringify(baseline.plan ?? []) === JSON.stringify(compressed.plan ?? []),
    tokensSaved: baseline.inputTokens - compressed.inputTokens,
    latencyMs: compressed.durationMs - baseline.durationMs,
  };
}

/**
 * Runs each task with and without compression, one after the other through the agent's own provider, with telemetry
 * off so evaluation runs never reach scores. A harness: it compares outcomes, it does not judge them.
 */
export async function evalCompression(params: EvalCompressionParams): Promise<CompressionEvalReport> {
  const { createAgent, agent, tasks, compressor } = params;
  const { compression, ...withoutCompression } = agent;
  const baselineAgent = createAgent(withoutCompression);
  const compressedAgent = createAgent({ ...agent, compression: { ...compression, compressor } });
  const results: CompressionEvalResult[] = [];
  for (const input of tasks) {
    const baseline = toSide(await baselineAgent.task({ ...input, disableTelemetry: true }));
    const compressed = toSide(await compressedAgent.task({ ...input, disableTelemetry: true }));
    results.push(compare({ task: input.task, baseline, compressed }));
  }
  const count = (predicate: (result: CompressionEvalResult) => boolean): number => results.filter(predicate).length;
  const sum = (value: (result: CompressionEvalResult) => number): number => results.reduce((total, result) => total + value(result), 0);
  return {
    results,
    summary: {
      tasks: results.length, sameStatus: count(({ isSameStatus }) => isSameStatus), sameAnswer: count(({ isSameAnswer }) => isSameAnswer),
      sameCriteria: count(({ isSameCriteria }) => isSameCriteria), tokensSaved: sum(({ tokensSaved }) => tokensSaved), latencyMs: sum(({ latencyMs }) => latencyMs),
    },
  };
}
