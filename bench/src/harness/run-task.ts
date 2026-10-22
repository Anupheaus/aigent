import { checkResult } from '../check/check-result.js';
import { normalisePath } from '../check/set-metrics.js';
import { tierOf } from '../check/tiers.js';
import type { Tier } from '../check/tiers.js';
import type { GeneratedRepo } from '../generate/repo-types.js';
import type { SolverAnswer, TaskSpec } from '../task-spec.js';
import type { Solver } from '../solvers/solver-types.js';
import { benchRepo } from './repo-cache.js';
import { repoTools } from './repo-tools.js';
import type { ToolSetBuilder } from './repo-tools.js';
import { recordTools } from './tool-recorder.js';
import type { ToolRecord } from './tool-recorder.js';

/** One run of one solver on one task. */
export interface RunRow {
  taskId: string;
  family: string;
  solver: string;
  heldOut: boolean;
  correct: boolean;
  precision: number;
  recall: number;
  f1: number;
  tier: Tier;
  tokens: number;
  turns: number;
  toolCalls: number;
  ms: number;
  decoyHits: number;
  failures: string[];
  tools: Record<string, ToolRecord>;
}

/** Answer paths relative to the repository root, whatever form the solver used (absolute, `./`, backslashes). */
function relativeToRoot(params: { answer: SolverAnswer | undefined; root: string }): SolverAnswer | undefined {
  const { answer, root } = params;
  const strip = (path: string): string => {
    const normal = normalisePath(path);
    const base = normalisePath(root);
    return normal.startsWith(`${base}/`) ? normal.slice(base.length + 1) : normal;
  };
  if (answer == null) return undefined;
  if ('files' in answer) return { files: answer.files.map(strip) };
  if ('bugs' in answer) return { bugs: answer.bugs.map(bug => ({ ...bug, path: strip(bug.path) })) };
  return answer;
}

/** Runs `solver` on `spec` over its generated repository (with the spec's trap conditions) and judges the result. */
export async function runTask(params: { spec: TaskSpec; solver: Solver; tools?: ToolSetBuilder; repo?: GeneratedRepo }): Promise<RunRow> {
  const { spec, solver, tools: build } = params;
  const repo = params.repo ?? await benchRepo(spec.repo);
  const recorder = recordTools(repoTools({ repo, ...(spec.trap == null ? {} : { trap: spec.trap }), ...(build == null ? {} : { build }) }));
  const outcome = await solver.solve({ prompt: spec.prompt, scope: spec.scope, tools: recorder.tools });
  const check = checkResult(spec, relativeToRoot({ answer: outcome.answer, root: repo.root }));
  const { tokens, turns, toolCalls, ms } = outcome.usage;
  return {
    taskId: spec.id, family: spec.family, solver: solver.id, heldOut: spec.heldOut,
    correct: check.correct, precision: check.precision, recall: check.recall, f1: check.f1,
    tier: tierOf({ spec, check, usage: { tokens, turns, toolCalls, ms } }),
    tokens, turns, toolCalls, ms, decoyHits: check.decoyHits,
    failures: [...outcome.failures, ...(check.reason == null ? [] : [check.reason])],
    tools: recorder.records(),
  };
}
