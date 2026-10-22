import type { SolverAnswer } from '../task-spec.js';

/** One tool call a policy asks for. */
export interface PolicyCall {
  name: string;
  args: unknown;
}

/** A tool call's outcome as the model saw it: the parsed envelope, or the raw text when it was not JSON. */
export interface PolicyResult {
  name: string;
  args: unknown;
  ok: boolean;
  /** The envelope's `result` (for batch tools, the per-item entries). */
  result?: unknown;
  error?: { code?: string; message?: string };
  /** The tool message text exactly as sent to the model. */
  text: string;
}

/**
 * What a scripted policy sees: only what a model would (the prompt, the scope and the tools' results). Each `call`
 * is one model turn whose tool calls run through the real agent loop; the policy's return value is its final answer.
 */
export interface PolicyContext {
  prompt: string;
  scope: string[];
  /** Names of the tools the agent offers (the model sees their schemas). */
  tools: string[];
  call(calls: PolicyCall[]): Promise<PolicyResult[]>;
}

/** A deterministic strategy that plays the model: it decides each turn's tool calls from the previous results. */
export type Policy = (ctx: PolicyContext) => Promise<SolverAnswer>;
