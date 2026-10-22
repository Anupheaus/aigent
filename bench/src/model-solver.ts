import { anthropic, deepseek, ollama } from '../../src/index.js';
import type { Provider } from '../../src/index.js';
import { benchError } from './bench-error.js';
import { runBenchAgent } from './solvers/scripted-solver.js';
import type { Solver } from './solvers/solver-types.js';

/** What the bench agent is told (linted against every answer: no hints). */
export const MODEL_PERSONA = 'You are a careful engineer answering questions about a codebase with the filesystem tools.';
export const MODEL_SKILLSET = [
  'Search before reading; batch related calls; never guess paths.',
  'Answer with JSON only: {"files": [...]} for files (paths relative to the repository root), {"none": true} when nothing matches,',
  '{"bugs": [{"path", "line", "cause"}]} for bugs, or {"text": "..."} for lists such as endpoints or names (one per line).',
].join(' ');

/** A solver backed by a real model through `createAigent` (persona and skillset above, the task's tools). */
export function createModelSolver(params: { provider: Provider; model: string; id?: string }): Solver {
  const { provider, model, id = `model:${model}` } = params;
  return { id, solve: ({ prompt, scope, tools }) => runBenchAgent({ provider, model, tools, prompt, scope, persona: MODEL_PERSONA, skillset: MODEL_SKILLSET }) };
}

/**
 * The model tier's provider from the environment: `BENCH_MODEL` = `ollama:<model>`, `deepseek:<model>` or
 * `anthropic:<model>` (with `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY`). The model tier is opt-in and is never run by tests.
 */
export function modelSolverFromEnv(env: Record<string, string | undefined>): Solver {
  const spec = env['BENCH_MODEL'];
  const [providerId = '', ...rest] = (spec ?? '').split(':');
  const model = rest.join(':');
  if (spec == null || model === '') throw benchError('BENCH_MODEL must be <provider>:<model> (ollama, deepseek or anthropic)', { value: spec ?? null });
  const key = (name: string): string => {
    const value = env[name];
    if (value == null || value === '') throw benchError(`BENCH_MODEL '${spec}' needs ${name}`, { name });
    return value;
  };
  const provider = providerId === 'ollama' ? ollama() : providerId === 'deepseek' ? deepseek({ apiKey: key('DEEPSEEK_API_KEY') }) : providerId === 'anthropic' ? anthropic({ apiKey: key('ANTHROPIC_API_KEY') }) : undefined;
  if (provider == null) throw benchError(`BENCH_MODEL provider '${providerId}' is not one of ollama, deepseek, anthropic`, { providerId });
  return createModelSolver({ provider, model: `${provider.id}:${model}` });
}
