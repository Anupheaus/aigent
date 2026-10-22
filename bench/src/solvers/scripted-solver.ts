import { createAigent, createInMemoryStore } from '../../../src/index.js';
import type { Provider, TaskResult, Tool } from '../../../src/index.js';
import { parseAnswer } from './parse-answer.js';
import { createPolicyProvider } from './policy-provider.js';
import type { Policy } from './policy-types.js';
import type { Solver, SolverOutcome } from './solver-types.js';

/** Generous run limits: budgets judge efficiency, the limits only stop runaways. */
export const BENCH_LIMITS = { maxTurns: 60, maxToolCalls: 400 } as const;
const FIXED_NOW = Date.UTC(2026, 0, 1);

/** Runs one task through a fresh runtime (no shared cache, a fixed clock, no date in the prompt) and measures it. */
export async function runBenchAgent(params: { provider: Provider; model: string; tools: Tool[]; prompt: string; scope: string[]; persona?: string; skillset?: string }): Promise<SolverOutcome> {
  const { provider, model, tools, prompt, scope, persona, skillset } = params;
  let tick = FIXED_NOW;
  const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false, volatile: { dateTime: false }, clock: { now: () => (tick += 1) } });
  const agent = ai.agent({ name: 'bench', model, tools, todo: false, shapers: 'off', limits: BENCH_LIMITS, ...(persona == null ? {} : { persona }), ...(skillset == null ? {} : { skillset }) });
  const started = performance.now();
  let result: TaskResult | undefined;
  let thrown: string | undefined;
  try {
    result = await agent.task({ task: prompt, inScope: scope, unattended: true });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  } finally {
    await ai.close();
  }
  const ms = Math.round(performance.now() - started);
  if (result == null) return { usage: { tokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0, ms }, status: 'failed', failures: [thrown ?? 'no result'] };
  const { usage, status, errors, failure, answer } = result;
  const parsed = status === 'completed' ? parseAnswer(answer) : undefined;
  return {
    ...(parsed == null ? {} : { answer: parsed }),
    usage: { tokens: usage.inputTokens + usage.outputTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, turns: usage.turns, toolCalls: usage.toolCalls, ms },
    status, failures: [...errors.map(({ message }) => message), ...(failure == null ? [] : [failure])],
  };
}

/** A solver that plays `policy` through the real agent loop and tools, so turns, tokens and calls are the library's own. */
export function createScriptedSolver(params: { id: string; policy: Policy }): Solver {
  const { id, policy } = params;
  return {
    id,
    solve: ({ prompt, scope, tools }) => runBenchAgent({ provider: createPolicyProvider({ policy, prompt, scope }), model: 'policy:scripted', tools, prompt, scope }),
  };
}
