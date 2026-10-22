import type { ProcessRunner } from '../../../security/process-runner.js';
import { createNodeProcessRunner } from '../../../security/process-runner-node.js';
import type { ShellPolicy } from '../../../security/shell-policy-types.js';
import { toolFailure } from '../../tool-failure.js';
import type { ToolFailure } from '../../tool-failure.js';

/** When `shell_run` asks a person: always, or as each command's `requiresApproval` says. */
export type ShellApprovals = 'always' | 'by-policy';

/** `shellTools(options)`. */
export interface ShellToolsOptions {
  /** The command authority (deny by default). */
  policy: ShellPolicy;
  /** Default: real processes (`createNodeProcessRunner()`). */
  runner?: ProcessRunner;
  /** Default `by-policy`. */
  approvals?: ShellApprovals;
  /** Default true: a call's items run one at a time, in order; false runs them in parallel within `maxConcurrent`. */
  sequential?: boolean;
}

export interface ShellDeps {
  policy: ShellPolicy;
  runner: ProcessRunner;
  approvals: ShellApprovals;
  sequential: boolean;
}

export function resolveShellDeps(options: ShellToolsOptions): ShellDeps {
  const { policy, runner = createNodeProcessRunner(), approvals = 'by-policy', sequential = true } = options;
  return { policy, runner, approvals, sequential };
}

/** Processes running per policy now, and the starts waiting for a slot. */
const slots = new WeakMap<ShellPolicy, { running: number; waiting: (() => void)[] }>();

function abortedWhileWaiting(): ToolFailure {
  return toolFailure({ category: 'aborted', code: 'aborted', message: 'The run was stopped while the command waited for a free process slot; it never started', retryable: false });
}

/** Waits for a slot handed over by a finishing process; an abort leaves the queue (no slot is taken) and rejects. */
function waitForSlot(params: { waiting: (() => void)[]; signal?: AbortSignal }): Promise<void> {
  const { waiting, signal } = params;
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      const at = waiting.indexOf(take);
      if (at >= 0) waiting.splice(at, 1);
      reject(abortedWhileWaiting());
    };
    const take = (): void => { signal?.removeEventListener('abort', onAbort); resolve(); };
    waiting.push(take);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `work` once fewer than the policy's `maxConcurrent` processes are running through it. A start still waiting
 * when `signal` aborts gives up (an `aborted` failure) and never runs.
 */
export async function withProcessSlot<T>(params: { policy: ShellPolicy; signal?: AbortSignal; work(): Promise<T> }): Promise<T> {
  const { policy, signal, work } = params;
  if (signal?.aborted === true) throw abortedWhileWaiting();
  const state = slots.get(policy) ?? { running: 0, waiting: [] };
  slots.set(policy, state);
  if (state.running >= policy.limits.maxConcurrent) await waitForSlot({ waiting: state.waiting, ...(signal == null ? {} : { signal }) });
  else state.running += 1;
  try {
    return await work();
  } finally {
    // A waiting start takes this slot over directly, so the count never dips below what is running.
    const next = state.waiting.shift();
    if (next != null) next(); else state.running -= 1;
  }
}

/** `npm run build`-style title: the command and its first arguments, cut to a readable length. */
export function commandTitle(params: { command: string; args: readonly string[] }): string {
  const { command, args } = params;
  const MAX_TITLE_CHARS = 60;
  const text = [command, ...args.slice(0, 3)].join(' ');
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…` : text;
}
