import { describeError } from '../core/describe-value.js';
import { frozenCopy } from './frozen-copy.js';
import type { PluginHooks, RunEndInfo, RunErrorInfo, RunStartInfo, ToolCallInfo, ToolResultInfo } from './plugin-types.js';

/** How long one hook may take before the run stops waiting for it. */
export const HOOK_TIMEOUT_MS = 1_000;

/** One plugin's hooks, in registration order. */
export interface RegisteredHooks {
  plugin: string;
  hooks: PluginHooks;
}

/** The info each hook receives. */
export interface HookInfo {
  onRunStart: RunStartInfo;
  onToolCall: ToolCallInfo;
  onToolResult: ToolResultInfo;
  onRunEnd: RunEndInfo;
  onError: RunErrorInfo;
}

export type HookName = keyof HookInfo;

export interface HookCall<TName extends HookName> {
  hook: TName;
  info: HookInfo[TName];
}

export interface RunHooks {
  /** Queues every plugin's `hook` with a frozen copy of `info`; never blocks the run and never throws. */
  call<TName extends HookName>(params: HookCall<TName>): void;
  /** Resolves (never rejects) once every queued hook has finished, failed or timed out. */
  settled(): Promise<void>;
}

export interface CreateRunHooksParams {
  /** The runtime's plugins with hooks, read when each event is queued (plugins added by `ai.use` take part). */
  plugins(): RegisteredHooks[];
  /** Receives one message per failed or timed-out hook (the run emits it as a `warning`). */
  warn(message: string): void;
  /** Default `HOOK_TIMEOUT_MS`. */
  timeoutMs?: number;
}

type Outcome = { kind: 'done' } | { kind: 'failed'; error: unknown } | { kind: 'timeout' };

/** Runs one hook, bounded by the timeout; its result is ignored (hooks observe). */
async function runOne(params: { invoke(): unknown; timeoutMs: number }): Promise<Outcome> {
  const { invoke, timeoutMs } = params;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    // A hung hook must not keep the process alive.
    timer.unref?.();
  });
  // Promise.resolve().then runs a synchronous hook inside the chain, so its throw becomes a rejection here.
  const work = Promise.resolve().then(invoke).then((): Outcome => ({ kind: 'done' }), (error: unknown): Outcome => ({ kind: 'failed', error }));
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The hook pipeline of one run: hooks run one at a time, in event order then plugin order, off the run's path. */
export function createRunHooks(params: CreateRunHooksParams): RunHooks {
  const { plugins, warn, timeoutMs = HOOK_TIMEOUT_MS } = params;
  let chain: Promise<void> = Promise.resolve();

  function call<TName extends HookName>(hookCall: HookCall<TName>): void {
    const { hook, info } = hookCall;
    const observers = plugins().filter(({ hooks }) => hooks[hook] != null);
    if (observers.length === 0) return;
    for (const { plugin, hooks } of observers) {
      chain = chain.then(async () => {
        const handler = hooks[hook] as ((value: HookInfo[TName]) => unknown) | undefined;
        // Copied per plugin: one plugin's hook can never see what another did with its copy.
        const outcome = await runOne({ invoke: () => handler?.(frozenCopy(info)), timeoutMs });
        if (outcome.kind === 'failed') warn(`Plugin '${plugin}' hook ${hook} failed: ${describeError(outcome.error)}`);
        if (outcome.kind === 'timeout') warn(`Plugin '${plugin}' hook ${hook} did not finish within ${timeoutMs} ms; the run continued without it`);
      });
    }
  }

  return { call, settled: () => chain };
}
