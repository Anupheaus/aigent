import type { TaskResult } from '../core/agent-types.js';
import type { RunSummary } from '../core/finish-agent-run.js';
import type { SteerSource } from '../core/run-agent-turns.js';
import type { NewContextMessage } from '../core/run-context.js';
import { startAgentRun } from '../core/start-agent-run.js';
import type { ResolvedAgent, RuntimeServices } from '../core/start-task-run.js';
import { parseTaskInput } from '../core/task-input.js';
import type { ModelSettings } from '../core/model-settings.js';
import type { ProviderMessage } from '../providers/provider-types.js';
import type { Tool } from '../tools/tool-types.js';
import type { PatchLog } from './apply-patch.js';
import { buildChatBrief } from './chat-brief.js';
import { finishTurn } from './finish-turn.js';
import { agentMessage } from './message-builders.js';
import type { RunRestore } from '../resume/prepare-run-resume.js';
import type { TurnRunControl } from './turn-handle.js';
import { createTurnRecorder } from './turn-recorder.js';

/** The agent and runtime a chat runs on. */
export interface ChatRuntime {
  agent: ResolvedAgent;
  services: RuntimeServices;
}

/** A session's settings for its turns; `context` changes with `setContext`. */
export interface ChatSettings {
  context?: string;
  constraints?: string[];
  unattended?: boolean;
  modelSettings?: ModelSettings;
  signal?: AbortSignal;
}

export interface StartChatTurnParams {
  runtime: ChatRuntime;
  log: PatchLog;
  settings: ChatSettings;
  /** The agent message to create and stream into. */
  messageId: string;
  /** The message being answered. */
  replyTo: string;
  branchId: string;
  threadId?: string;
  /** The model-visible history, ending with what is being answered. */
  history: NewContextMessage[];
  /** Recorded as the run's task (the user's words). */
  taskText: string;
  steer?: SteerSource;
  tools?: Tool[];
  /** The message that interrupted this reply, once one did. */
  interruptedBy(): string | undefined;
  /** Continues a turn suspended before a restart instead of answering `history`. */
  restore?: RunRestore;
}

const EMPTY_TASK_TEXT = '(no text)';

/** Starts the agent's reply: creates its message, runs the loop over the history and mirrors the run into patches. */
export function startChatTurn(params: StartChatTurnParams): TurnRunControl {
  const { runtime: { agent, services }, log, settings, messageId, replyTo, branchId, threadId, history, taskText, steer, tools, interruptedBy, restore } = params;
  const { clock, ids } = services;
  const now = (): number => clock.now();
  const { context, constraints, unattended, modelSettings, signal } = settings;
  const input = parseTaskInput({
    task: taskText === '' ? EMPTY_TASK_TEXT : taskText, ...(unattended == null ? {} : { unattended }), ...(modelSettings == null ? {} : { modelSettings }), ...(signal == null ? {} : { signal }),
  });
  log.append({ type: 'message-added', message: agentMessage({ id: messageId, branchId, createdAt: now(), agentName: agent.name, instanceId: agent.instanceId, replyTo, ...(threadId == null ? {} : { threadId }) }) });
  const committed: ProviderMessage[] = [];
  let summary: RunSummary | undefined;
  const brief = buildChatBrief({ ...(context == null ? {} : { context }), ...(constraints == null ? {} : { constraints }), ...(unattended == null ? {} : { unattended }) });
  const run = startAgentRun({
    agent, services, input, ...(tools == null ? {} : { tools }), ...(restore == null ? {} : { restore }),
    conversation: { history, messageId, sessionId: log.state().sessionId, ...(brief == null ? {} : { brief }), ...(steer == null ? {} : { steer }), onCommit: messages => { committed.push(...messages); } },
    onFinished: finished => { summary = finished; },
  });
  const recorder = createTurnRecorder({ log, ids, messageId, replyTo, branchId, now, ...(threadId == null ? {} : { threadId }) });

  const reply = (async () => {
    for await (const event of run) recorder.observe({ event, runId: run.runId });
    const result: TaskResult = await run;
    recorder.close();
    const by = interruptedBy();
    return finishTurn({ log, messageId, result, history: committed, agentName: agent.name, instanceId: agent.instanceId, now, ...(summary == null ? {} : { summary }), ...(by == null ? {} : { interruptedBy: by }) });
  })();
  return { runId: run.runId, streamId: restore?.streamId ?? run.runId, events: run, reply, stop: options => run.stop(options) };
}
