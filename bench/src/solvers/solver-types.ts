import type { Tool } from '../../../src/index.js';
import type { SolverAnswer } from '../task-spec.js';

/** What a solver is given: the prompt, the scope and the tools over the repository. Never the manifest or truth. */
export interface SolverTask {
  prompt: string;
  scope: string[];
  tools: Tool[];
}

/** What a run used, measured by the library's telemetry with the bench's fixed token estimator. */
export interface SolverUsage {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  toolCalls: number;
  ms: number;
}

export interface SolverOutcome {
  answer?: SolverAnswer;
  usage: SolverUsage;
  /** The run's status (`completed`, `failed`...). */
  status: string;
  /** Tool failures and run failures, as messages. */
  failures: string[];
}

export interface Solver {
  id: string;
  solve(task: SolverTask): Promise<SolverOutcome>;
}
