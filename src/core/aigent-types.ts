import type { CacheOptions } from '../cache/cache-types.js';
import type { CompressionEvalReport, EvalCompressionParams } from '../compression/eval-compression.js';
import type { VolatileOptions } from '../context/volatile-block.js';
import type { UserFeedback } from '../feedback/feedback-records.js';
import type { Provider } from '../providers/provider-types.js';
import type { Scheduler, SchedulerOptions } from '../scheduler/scheduler-types.js';
import type { Pricing, Report, ReportFilter } from '../scoring/report-types.js';
import type { PurgeFilter, Store } from '../store/store-types.js';
import type { Redact } from '../telemetry/redact.js';
import type { RetentionOptions } from '../telemetry/retention.js';
import type { RunTrace } from '../telemetry/run-record.js';
import type { ActivityOptions } from './activity.js';
import type { ResumeOptions } from '../resume/instance-runtime.js';
import type { Agent, AgentDefinition } from './agent-types.js';
import type { ModelSettings } from './model-settings.js';
import type { Clock, IdGenerator, RandomSource, Sleeper } from './runtime-services.js';

export interface AigentOptions {
  /** Every provider agents may use; ids must be unique. */
  providers: Provider[];
  /** Where run records are written; nothing is persisted without one. */
  store?: Store;
  clock?: Clock;
  ids?: IdGenerator;
  /** Waits between retries (default: real timers). Inject a fake to control time in tests. */
  sleep?: Sleeper;
  /** Jitter source (default `Math.random`). */
  random?: RandomSource;
  /**
   * Admits every provider call (concurrency, per-minute budgets, priority lanes, fairness). Pass one `Scheduler` to
   * several `createAigent` instances to share limits, or options to build one. Default: no limits.
   */
  scheduler?: Scheduler | SchedulerOptions;
  /** Runtime-wide model settings; agent and task settings win over them, field by field. */
  modelSettings?: ModelSettings;
  /** Per-provider default settings, keyed by provider id; the lowest-precedence layer. */
  providerModelSettings?: Record<string, ModelSettings>;
  /**
   * Applied to every record of every collection before it reaches the store (it gets a copy and may change `value`).
   * If it throws, that record is not written and the run emits a warning.
   */
  redact?: Redact;
  /**
   * Store task text, answers, tool argument values and feedback text (default true). False keeps metrics, argument
   * shapes and digests, and only the kinds and lengths of user and agent feedback text.
   */
  captureContent?: boolean;
  /** Retention hints stamped on records as `expiresAt`; the store decides whether to honour them. */
  retention?: RetentionOptions;
  /** Default for agents that do not set `enableFeedback`; when absent, on unless `NODE_ENV` is `production`. */
  enableFeedback?: boolean;
  /** Model prices keyed `provider:model`, so `ai.report()` can score cost; cost is null without them. */
  pricing?: Pricing;
  /**
   * The tool-result cache for tools declared `cache: true` (on by default): limits, or false to turn it off. Entries go
   * to the runtime `store` (collection `toolcache`); without a store, or with `captureContent: false`, to a private
   * in-memory store, so tool results never reach a store whose owner asked for no content.
   */
  cache?: CacheOptions | false;
  /**
   * The trailing `# Current state` block added to every request (date and time, locale, progress, plan and todo
   * statuses), so the messages before it stay byte-stable for provider prompt caching.
   */
  volatile?: VolatileOptions;
  /** Activity updates (task and chat): at most one per `throttleMs` (default 250), a heartbeat every `heartbeatMs` (default 5000) while busy. */
  activity?: ActivityOptions;
  /**
   * Resumable instances: every run and chat turn writes checkpoints and a call ledger to the store (an in-memory one
   * without `store`), and each instance is held by a lease (`{ ttlMs: 30_000 }` by default; false for none).
   */
  resume?: ResumeOptions;
}

export interface Aigent {
  /** Validates the definition (throws `invalid_definition` / `unknown_provider`) and returns the agent. */
  agent(definition: AgentDefinition): Agent;
  /**
   * Restores a stored instance (needs `resume`): its agent's definition must have been given to `ai.agent` in this
   * runtime. Resolves once the instance is open (lease taken); rejects `instance_locked` or `invalid_input`.
   */
  restoreAgent(instanceId: string): Promise<Agent>;
  /**
   * Resolves once every run and `ai.feedback` call started so far (and any started while closing) has settled and every pending store
   * write has been flushed, so run records are not lost on shutdown. It does not stop runs; stop them first to close quickly.
   * Open chats are closed first (`chat.close()`): their running turns finish, and a turn waiting for an answer is cancelled.
   */
  close(): Promise<void>;
  /** A stored run with its ordered steps, or undefined when it was not stored (no store, unknown id, disableTelemetry). */
  trace(runId: string): Promise<RunTrace | undefined>;
  /**
   * Deletes matching records from every collection through `Store.purge`; resolves with how many went. Rejects with
   * `invalid_input` for an empty filter, without a store, or when the store does not implement `purge`.
   */
  purge(filter: PurgeFilter): Promise<number>;
  /**
   * Records a user's rating of a response (validated; a later call amends it and keeps the history) and marks the run
   * record's `userVerdict`. Works after the run, and from any runtime on the same store. Rejects with `invalid_input`
   * for an invalid payload, an unknown `responseId` (including disableTelemetry runs) or no store.
   */
  feedback(feedback: UserFeedback): Promise<void>;
  /**
   * Scores (against each agent version's own rolling baseline), findings and an optional version comparison over the
   * stored runs that match `filter`. Rejects with `invalid_input` for an invalid filter; empty without a store.
   */
  report(filter?: ReportFilter): Promise<Report>;
  /**
   * Runs each task with the agent as defined but without compression, then with `compressor`, through the agent's own
   * provider and with telemetry off, and compares status, answer, plan outcome, input tokens and time.
   */
  evalCompression(params: Omit<EvalCompressionParams, 'createAgent'>): Promise<CompressionEvalReport>;
}
