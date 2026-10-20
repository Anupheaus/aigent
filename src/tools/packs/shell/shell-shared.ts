import type { ProcessRunner } from '../../../security/process-runner.js';
import { createNodeProcessRunner } from '../../../security/process-runner-node.js';
import type { ShellPolicy } from '../../../security/shell-policy-types.js';

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

/** Runs `work` once fewer than the policy's `maxConcurrent` processes are running through it. */
export async function withProcessSlot<T>(params: { policy: ShellPolicy; work(): Promise<T> }): Promise<T> {
  const { policy, work } = params;
  const state = slots.get(policy) ?? { running: 0, waiting: [] };
  slots.set(policy, state);
  if (state.running >= policy.limits.maxConcurrent) await new Promise<void>(resolve => { state.waiting.push(resolve); });
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
