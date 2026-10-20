import type { ToolCache } from '../cache/cache-types.js';
import type { FeedbackCollector } from '../feedback/feedback-collector.js';
import type { Provider } from '../providers/provider-types.js';
import type { Scheduler } from '../scheduler/scheduler-types.js';
import type { Pricing } from '../scoring/report-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import type { ShapersSetting } from '../shapers/shaper-types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ActivityOptions } from './activity.js';
import type { TaskRun } from './agent-types.js';
import type { UserFeedback } from '../feedback/feedback-records.js';
import type { ModelSettings } from './model-settings.js';
import type { ResiliencePolicy } from './resilience-policy.js';
import type { CompactionPolicy } from '../context/compaction-policy.js';
import type { CompressionCache } from '../compression/compression-cache.js';
import type { ResolvedCompression } from '../compression/compression-options.js';
import type { VolatileOptions } from '../context/volatile-block.js';
import { startAgentRun } from './start-agent-run.js';
import { createAskUserTool } from '../chat/ask-user-tool.js';
import { askThrough } from '../chat/task-questions.js';
import type { InstanceRuntime } from '../resume/instance-runtime.js';
import type { ApprovalCenter } from '../approvals/approval-gate.js';
import type { RunRestore } from '../resume/prepare-run-resume.js';
import type { TelemetrySettings } from './run-telemetry.js';
import type { Clock, IdGenerator, RandomSource, Sleeper } from './runtime-services.js';
import type { StaticPrompt } from './static-prompt.js';
import type { PromptPersona } from './system-prompt.js';
import type { TaskInput, TaskLimits } from './task-input.js';
/** A model an agent can call: provider resolved, plus that provider's settings layer. */
export interface ModelTarget {
  /** `provider:model`, as written in the definition. */
  reference: string;
  provider: Provider;
  /** Model id without the provider prefix. */
  model: string;
  /** `createAigent({ providerModelSettings })` for this provider. */
  providerSettings?: ModelSettings;
}

/** An agent definition after validation: provider resolved, registry built, version computed. */
export interface ResolvedAgent {
  name: string;
  instanceId: string;
  /** The agent's model first, then its fallback models. */
  targets: [ModelTarget, ...ModelTarget[]];
  resilience: ResiliencePolicy;
  prompt: PromptPersona;
  registry: ToolRegistry;
  limits?: TaskLimits;
  agentSettings?: ModelSettings;
  /** `createAigent({ modelSettings })`. */
  runtimeSettings?: ModelSettings;
  agentVersion: string;
  /** The definition's human version label. */
  version?: string;
  /** Present when feedback is enabled; holds each run's `aigent_feedback` entries until they are stored. */
  feedbackCollector?: FeedbackCollector;
  /** The definition's `shapers`, validated. */
  shapers?: ShapersSetting;
  /** The agent has the built-in `todo` tool (`todo` is not false). */
  isTodoEnabled: boolean;
  /** The agent's compaction policy, defaults filled in. */
  compaction: CompactionPolicy;
  /** `compactionModel`, when the definition sets one. */
  compactionTarget?: ModelTarget;
  /** The agent's compression settings, when it compresses. */
  compression?: ResolvedCompression;
  /** The persona fields as sent, compressed once per agent and memoised (lazily, on the first task or preview). */
  staticPrompt: StaticPrompt;
  /** The instance's approvals (pending requests, decisions, audit). */
  approvals?: ApprovalCenter;
}

/** Shared, per-`createAigent` services. */
export interface RuntimeServices {
  clock: Clock;
  ids: IdGenerator;
  /** Flushed by `ai.close()`; every store write goes through it. */
  writeQueue: WriteQueue;
  telemetry: TelemetrySettings;
  /** `ai.feedback`, behind `TaskResult.feedback`. */
  submitFeedback(feedback: UserFeedback): Promise<void>;
  sleep: Sleeper;
  random: RandomSource;
  scheduler: Scheduler;
  /** The tool-result cache shared by every agent of the runtime; absent with `cache: false`. */
  cache?: ToolCache;
  /** `createAigent({ volatile })`, validated. */
  volatile: VolatileOptions;
  /** Whether runs warn when their prompt prefix changes between turns. */
  isPrefixMonitorEnabled: boolean;
  /** Compressed texts, shared by every agent of the runtime (and other runtimes on the same store). */
  compressionCache: CompressionCache;
  /** `createAigent({ pricing })`: prices activity updates and chat message meta. */
  pricing?: Pricing;
  /** `createAigent({ activity })`: throttle and heartbeat of activity updates. */
  activity?: ActivityOptions;
  /**
   * Real timers for activity throttling and heartbeats, kept apart from `sleep` (retry backoff), which tests often
   * replace with an instant sleeper.
   */
  activityTimers: Sleeper;
  /** `createAigent({ resume })`: instances, leases and checkpoints. Absent: runs are not checkpointed. */
  resume?: InstanceRuntime;
}

export interface StartTaskRunParams {
  agent: ResolvedAgent;
  services: RuntimeServices;
  /** Already validated. */
  input: TaskInput;
  /** Continues an interrupted run (`agent.resume`). */
  restore?: RunRestore & { runId: string; hadUser: boolean };
}

/** `ask_user` for a resumed run whose user is gone: offered (so the tools, and the prompt prefix, stay the same) but refused. */
const NO_USER_ANYMORE = async (): Promise<never> => { throw new Error('No user is attached to this resumed run; make a reasonable assumption and state it'); };

/** Starts a task in the background and returns its awaitable, iterable, stoppable handle. */
export function startTaskRun(params: StartTaskRunParams): TaskRun {
  const { input: { onQuestion, unattended }, restore } = params;
  // Without a user to answer, ask_user is not offered (a call is refused and the ambiguity policy applies).
  const hasUser = onQuestion != null && unattended !== true;
  const ask = onQuestion == null ? NO_USER_ANYMORE : askThrough(onQuestion);
  const tools = hasUser || restore?.hadUser === true ? [createAskUserTool(ask)] : [];
  return startAgentRun({ ...params, tools, ...(restore == null ? {} : { restore, runId: restore.runId }) });
}
