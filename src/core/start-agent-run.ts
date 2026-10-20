import type { ProviderMessage } from '../providers/provider-types.js';
import { createStabilityMonitor } from '../context/stability-monitor.js';
import { costOfUsage } from '../scoring/pricing.js';
import { measureQueueWait } from '../telemetry/measure-queue.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import type { Tool } from '../tools/tool-types.js';
import { createActivityPublisher } from './activity.js';
import type { ActivityPublisher } from './activity.js';
import type { AigentEvent } from './aigent-events.js';
import type { TaskResult, TaskRun } from './agent-types.js';
import { createEventStream } from './event-stream.js';
import type { TurnRouting } from './open-turn-stream.js';
import { buildPromptTexts } from './prompt-texts.js';
import { resolveModelSettings } from './resolve-model-settings.js';
import { runAgentTurns } from './run-agent-turns.js';
import type { SteerSource } from './run-agent-turns.js';
import { createRunCallbacks } from './run-callbacks.js';
import type { NewContextMessage } from './run-context.js';
import { createRunControl } from './run-control.js';
import { createRunEmitter } from './run-emitter.js';
import { createSteerInbox } from '../chat/steer-inbox.js';
import { finishAgentRun, resolveLimits } from './finish-agent-run.js';
import type { RunSummary } from './finish-agent-run.js';
import { setUpRunPlanning } from './run-planning-setup.js';
import { compactionSettings, promptCompressionContext, toProviderTarget } from './run-settings.js';
import type { RunCompression } from './run-compression.js';
import { setUpRunShaping } from './run-shaping.js';
import { taskInitialMessages } from './run-task.js';
import { createRunTelemetry } from './run-telemetry.js';
import type { ResolvedAgent, RuntimeServices } from './start-task-run.js';
import type { TaskInput } from './task-input.js';

/** What a chat turn adds to a run: its history instead of a task brief, and hooks into the loop. */
export interface ConversationRun {
  /** The session brief (chat context and constraints), when there is one. */
  brief?: string;
  /** The model-visible history of the active branch, ending with the message being answered. */
  history: NewContextMessage[];
  /** The chat's agent message, stamped on activity updates. */
  messageId: string;
  steer?: SteerSource;
  onCommit?(messages: ProviderMessage[]): void;
}

export interface StartAgentRunParams {
  agent: ResolvedAgent;
  services: RuntimeServices;
  /** Already validated. */
  input: TaskInput;
  /** Tools for this run only (e.g. `ask_user`). */
  tools?: Tool[];
  conversation?: ConversationRun;
  /** Called with the run's figures (as stored on its record) before `done`. */
  onFinished?(summary: RunSummary): void;
}

function initialMessages(params: { system: string; brief: string; conversation?: ConversationRun }): NewContextMessage[] {
  const { system, brief, conversation } = params;
  if (conversation == null) return taskInitialMessages({ systemPrompt: system, brief });
  const sessionBrief: NewContextMessage[] = conversation.brief == null ? [] : [{ kind: 'brief', message: { role: 'user', text: conversation.brief } }];
  return [{ kind: 'system', message: { role: 'system', text: system } }, ...sessionBrief, ...conversation.history];
}

/** Starts one agent loop (a task, or a chat turn) in the background and returns its awaitable, iterable, stoppable handle. */
export function startAgentRun(params: StartAgentRunParams): TaskRun {
  const { agent, services, input, tools = [], conversation, onFinished } = params;
  const { name: agentName, instanceId, targets, resilience, feedbackCollector } = agent;
  const { clock, ids, sleep, random, scheduler } = services;
  const [target, ...fallbackTargets] = targets;
  const runId = ids.next('run');
  const responseId = ids.next('resp');
  const telemetry = createRunTelemetry({ now: () => clock.now(), runId, settings: services.telemetry, enableFeedback: feedbackCollector != null });
  const { registry: shapingRegistry, shaping } = setUpRunShaping({ registry: agent.registry, settings: input.shapers ?? agent.shapers, isFeedbackEnabled: feedbackCollector != null });
  const limits = resolveLimits(input.limits, agent.limits);
  const settings = resolveModelSettings({ task: input.modelSettings, agent: agent.agentSettings, runtime: agent.runtimeSettings, provider: target.providerSettings });
  const primary = toProviderTarget({ target, agent, input });
  const fallbacks = fallbackTargets.map(modelTarget => toProviderTarget({ target: modelTarget, agent, input }));
  const priority = input.priority ?? (input.unattended === true ? 'background' : 'interactive');
  const measuredScheduler = measureQueueWait({ scheduler, now: () => clock.now(), onWait: waitedMs => telemetry.timer.addQueuedMs(waitedMs) });
  const routing: TurnRouting = { targets: [primary, ...fallbacks], policy: resilience, sleep, random, usedLabels: new Set([primary.label]), scheduler: measuredScheduler, priority, agentName };
  const stream = createEventStream<AigentEvent, TaskResult>();
  let activity: ActivityPublisher | undefined;
  const emitter = createRunEmitter({ push: event => stream.push(event), activity: () => activity });
  const { emit } = emitter;
  const { control, stop, dispose } = createRunControl({ signal: input.signal, timeoutMs: limits.timeoutMs });
  const planned = setUpRunPlanning({ registry: shapingRegistry, input, isTodoEnabled: agent.isTodoEnabled, emit });
  const { planning } = planned;
  const registry = tools.length === 0 ? planned.registry : createToolRegistry([...planned.registry.list(), ...tools]);
  // Task steering: delivered at the next safe boundary like a chat's; a chat turn brings its own inbox.
  const taskInbox = createSteerInbox<string>({ toMessage: text => ({ role: 'user', text }) });
  const steer = conversation?.steer ?? taskInbox;
  const price = (usage: Parameters<typeof costOfUsage>[0]['usage']): number => costOfUsage({ model: primary.label, usage, ...(services.pricing == null ? {} : { pricing: services.pricing }) }) ?? 0;

  async function execute(): Promise<void> {
    activity = createActivityPublisher({
      runId, ...(conversation == null ? {} : { messageId: conversation.messageId }), clock, sleep: services.activityTimers, ...(services.activity == null ? {} : { options: services.activity }),
      maxTurns: limits.maxTurns, plan: planning.state.plan, criteriaTotal: input.acceptanceCriteria?.length ?? 0, price, publish: update => stream.push({ type: 'activity', update }),
    });
    for (const message of primary.warnings) emit({ type: 'warning', message });
    let compression: RunCompression | undefined;
    const resultData = await (async () => {
      try {
        // Chat turns use the persona only: the user's words arrive as history, not as task fields.
        const texts = await buildPromptTexts({ staticPrompt: agent.staticPrompt, ...(conversation == null ? { input } : {}), context: promptCompressionContext({ agent, services }) });
        for (const message of texts.warnings) emit({ type: 'warning', message });
        compression = agent.compression == null ? undefined : { settings: agent.compression, cache: services.compressionCache, log: [...texts.records] };
        return await runAgentTurns({
          runId, responseId, agentName, instanceId, initial: initialMessages({ system: texts.system, brief: texts.brief, ...(conversation == null ? {} : { conversation }) }), registry, clock, control, telemetry, emit,
          ...(compression == null ? {} : { compression }),
          ...(services.cache == null ? {} : { cache: services.cache }),
          ...(shaping == null ? {} : { shaping }),
          volatile: { options: services.volatile, monitor: createStabilityMonitor({ emit, isEnabled: services.isPrefixMonitorEnabled }), extras: planning.extras },
          planning, routing, compaction: compactionSettings({ agent, input, routing, settings }), showThinking: settings.showThinking ?? true, limits: { maxTurns: limits.maxTurns, maxToolCalls: limits.maxToolCalls },
          steer,
          ...(conversation == null ? {} : { keepPartialRound: true, ...(conversation.onCommit == null ? {} : { onCommit: conversation.onCommit }) }),
        });
      } finally {
        dispose();
      }
    })();
    emitter.endThinking();
    const undelivered = taskInbox.drain().length;
    if (undelivered > 0) emit({ type: 'warning', message: `${undelivered} steering message(s) arrived after the run's last model request and were not delivered` });
    activity.enter('finishing');
    const result = await finishAgentRun({
      agent, services, input, telemetry, result: resultData, targets: { primary, fallbacks: fallbacks.filter(({ label }) => routing.usedLabels.has(label)), runtimeSettings: settings }, emit,
      mode: conversation == null ? 'task' : 'chat', ...(compression == null ? {} : { compression }), price,
      ...(onFinished == null ? {} : { onFinished }),
    });
    activity.finish(result.status);
    // `done` is last and only after the records are flushed, so a consumer that sees it can read them.
    stream.push({ type: 'done', status: result.status, responseId });
    stream.finish(result);
  }

  // Deferred so the caller can attach iterators first (events are buffered regardless).
  queueMicrotask(() => { execute().catch(error => stream.fail(error)); });

  const thinkingContext = { runId, ...(conversation == null ? {} : { messageId: conversation.messageId }) };
  const callbacks = createRunCallbacks({ run: stream.run, context: () => thinkingContext });
  return Object.assign(stream.run, { runId, stop, cancel: () => stop({ mode: 'immediate' }), steer: (text: string) => taskInbox.push(text), ...callbacks });
}
