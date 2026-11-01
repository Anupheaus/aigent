import type { ToolCache } from '../cache/cache-types.js';
import type { RunPlanning } from '../planning/run-planning.js';
import type { ProviderMessage } from '../providers/provider-types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ApprovalCenter } from '../approvals/approval-gate.js';
import type { GuardrailRunContext } from '../guardrails/guardrail-types.js';
import type { RunCheckpoints } from '../resume/checkpoint-hooks.js';
import type { RestoredRun } from '../resume/reconcile-calls.js';
import type { AigentEvent } from './aigent-events.js';
import type { RunDelegation } from './delegation-types.js';
import type { TurnRouting } from './open-turn-stream.js';
import type { RunCompactionSettings } from './run-compaction.js';
import type { RunCompression } from './run-compression.js';
import type { NewContextMessage } from './run-context.js';
import type { RunControl } from './run-control.js';
import type { RunEffects } from './run-effects.js';
import type { RunGuardrails } from './run-guardrails.js';
import type { RunResponseCache } from './run-response-cache.js';
import type { RunShaping } from './run-shaping.js';
import type { RunTelemetry } from './run-turn.js';
import type { RunVolatile } from './run-volatile.js';
import type { Clock } from './runtime-services.js';

/** Supplies messages that arrived while the run was busy; read at each safe boundary (before a model request). */
export interface SteerSource {
  take(): ProviderMessage[];
}

/** Everything one agent loop needs, whatever started it (a task or a chat turn). */
export interface RunAgentTurnsParams {
  runId: string;
  /** Stable id of this run's answer, for user feedback. */
  responseId: string;
  agentName: string;
  instanceId: string;
  routing: TurnRouting;
  /** The messages the run starts from: the system prompt, then a task brief or a conversation's history. */
  initial: NewContextMessage[];
  /** Present when the agent compresses; tool results are compressed as they are committed. */
  compression?: RunCompression;
  registry: ToolRegistry;
  limits: { maxTurns: number; maxToolCalls: number };
  clock: Clock;
  control: RunControl;
  telemetry: RunTelemetry;
  /** The runtime's tool-result cache; absent when caching is off. */
  cache?: ToolCache;
  /** The run's shaping; absent when nothing can be shaped. */
  shaping?: RunShaping;
  /** The run's volatile block, minus the limits this function adds. */
  volatile: Omit<RunVolatile, 'maxTurns'>;
  planning: RunPlanning;
  compaction: RunCompactionSettings;
  /** Chat: record the round a stop or failure cut short (partial text, every dispatched call with its result). */
  keepPartialRound?: boolean;
  /** Called with each round's messages as they join the history, before compaction can change them. */
  onCommit?(messages: ProviderMessage[]): void;
  /** Steering messages, delivered at the next safe boundary as user messages. */
  steer?: SteerSource;
  /** With `resume`: the run's checkpoints and call ledger. */
  checkpoints?: RunCheckpoints;
  /** A resumed run's checkpoint and ledger; `initial` is then ignored. */
  restore?: RestoredRun;
  /** No user: interrupted calls that need approval are refused. */
  isUnattended?: boolean;
  /** The agent instance's approvals: calls whose tool requires approval wait here for `agent.approve`. */
  approvals?: ApprovalCenter;
  /** The run's guardrails; with `answer`, how the final answer is checked (the task's structured output, retries). */
  guardrails?: { checks: RunGuardrails; answer: GuardrailRunContext; outputRetries: number };
  /** An input guardrail blocked the run: it fails with this, before any request. */
  inputBlocked?: string;
  /** The run's side effects (dry-run plans). */
  effects?: RunEffects;
  /** How tools that start sub-runs (`delegate`) reach the runtime's agents. */
  delegation?: RunDelegation;
  /** `learning.responseCache`: identical reproducible requests are replayed. */
  responseCache?: RunResponseCache;
  emit(event: AigentEvent): void;
}
