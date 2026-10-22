import { describeError } from '../core/describe-value.js';
import { frozenCopy } from './frozen-copy.js';
import type { PluginHooks, RunEndInfo, RunErrorInfo, RunStartInfo, ToolCallInfo, ToolResultInfo } from './plugin-types.js';

/** How long one hook may take before the run stops waiting for it. */
export const HOOK_TIMEOUT_MS = 1_000;
/**
 * The run's end waits at most this many hook timeouts for the queue; above 1 so a single hook that times out at the
 * end still reports its own warning first.
 */
const SETTLE_TIMEOUT_FACTOR = 1.5;

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
  /**
   * Resolves (never rejects) once every queued hook has finished, failed or timed out, or after 1.5 hook timeouts in all;
   * then hooks still queued are abandoned (never started) with one warning.
   */
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

/**
 * The hook pipeline of one run: hooks run one at a time, in event order then plugin order, off the run's path. A plugin
 * whose hook timed out is skipped for the rest of the run, and `settled()` waits at most 1.5 timeouts in all, so slow
 * observers delay the run's end by a bounded amount however many events it had.
 */
export function createRunHooks(params: CreateRunHooksParams): RunHooks {
  const { plugins, warn, timeoutMs = HOOK_TIMEOUT_MS } = params;
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  /** Set once `settled()` gave up waiting: hooks not yet started never run and late outcomes are not reported. */
  let isAbandoned = false;
  /** Plugins that timed out in this run; their later hooks are skipped. */
  const timedOut = new Set<string>();

  function call<TName extends HookName>(hookCall: HookCall<TName>): void {
    const { hook, info } = hookCall;
    if (isAbandoned) return;
    const observers = plugins().filter(({ hooks }) => hooks[hook] != null);
    if (observers.length === 0) return;
    for (const { plugin, hooks } of observers) {
      queued += 1;
      chain = chain.then(async () => {
        queued -= 1;
        if (isAbandoned || timedOut.has(plugin)) return;
        const handler = hooks[hook] as ((value: HookInfo[TName]) => unknown) | undefined;
        // Copied per plugin: one plugin's hook can never see what another did with its copy.
        const outcome = await runOne({ invoke: () => handler?.(frozenCopy(info)), timeoutMs });
        if (isAbandoned) return;
        if (outcome.kind === 'failed') warn(`Plugin '${plugin}' hook ${hook} failed: ${describeError(outcome.error)}`);
        if (outcome.kind === 'timeout') {
          timedOut.add(plugin);
          warn(`Plugin '${plugin}' hook ${hook} did not finish within ${timeoutMs} ms; the run continued without it`);
        }
      });
    }
  }

  async function settled(): Promise<void> {
    const settleMs = timeoutMs * SETTLE_TIMEOUT_FACTOR;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>(resolve => {
      timer = setTimeout(() => resolve('deadline'), settleMs);
      timer.unref?.();
    });
    try {
      const winner = await Promise.race([chain.then(() => 'chain' as const), deadline]);
      if (winner === 'chain') return;
      // The hook running now still counts as abandoned: its outcome would arrive after the run ended.
      const abandoned = queued + 1;
      isAbandoned = true;
      warn(`Plugin hooks did not finish within ${settleMs} ms of the run ending; ${abandoned} queued hook(s) were abandoned`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { call, settled };
}
