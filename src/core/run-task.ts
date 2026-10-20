import type { Provider, ProviderMessage } from '../providers/provider-types.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { isAigentError } from './aigent-error.js';
import { describeError } from './describe-value.js';
import type { AigentEvent, TaskStatus } from './aigent-events.js';
import type { TaskResult } from './agent-types.js';
import { runTurn } from './run-turn.js';
import type { RunTotals, TurnStreamResult, TurnWork } from './run-turn.js';
import type { Clock } from './runtime-services.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { PromptPersona } from './system-prompt.js';
import { buildTaskBrief } from './task-brief.js';
import type { TaskInput } from './task-input.js';

export type AbortReason = 'user' | 'timeout';

/** Mutable control surface shared between the run and its `stop`/`cancel` handles. */
export interface RunControl {
  abortController: AbortController;
  isGracefulStopRequested(): boolean;
  /** Why the run was aborted, set before aborting. */
  abortReason(): AbortReason | undefined;
}

export interface RunTaskParams {
  runId: string;
  agentName: string;
  instanceId: string;
  /** Model id without the provider prefix. */
  model: string;
  provider: Provider;
  prompt: PromptPersona;
  input: TaskInput;
  registry: ToolRegistry;
  limits: { maxTurns: number; maxToolCalls: number };
  clock: Clock;
  control: RunControl;
  emit(event: AigentEvent): void;
}

interface TurnMessagesParams {
  turn: TurnStreamResult;
  executed: ExecutedToolCall[];
}

/** A run aborted by its timeout reached a limit; any other abort is a cancellation. */
function abortedStatus(control: RunControl): TaskStatus {
  return control.abortReason() === 'timeout' ? 'limit_reached' : 'cancelled';
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (isAigentError(error) && error.code === 'aborted');
}

function failedDetails(executed: ExecutedToolCall[]): ToolErrorDetail[] {
  return executed.flatMap(({ envelope }) => (envelope.ok ? [] : [envelope.error]));
}

/** The assistant message (with its tool calls) followed by one tool message per call, in call order. */
function turnMessages(params: TurnMessagesParams): ProviderMessage[] {
  const { turn: { visible, calls }, executed } = params;
  const assistant: ProviderMessage = calls.length > 0 ? { role: 'assistant', text: visible, toolCalls: calls } : { role: 'assistant', text: visible };
  const toolResults = executed.map(({ envelope }): ProviderMessage => ({ role: 'tool', toolCallId: envelope.id, text: JSON.stringify(envelope) }));
  return [assistant, ...toolResults];
}

/** Waits for everything a turn started; executions race the run's signal, so after an abort this settles promptly. */
async function drainWork(work: TurnWork): Promise<ExecutedToolCall[]> {
  const executed = await Promise.all(work.executions);
  await Promise.all(work.activities);
  return executed;
}

/** Runs the agent loop until the model answers, a limit is hit, the run is stopped or the provider fails. Never rejects for those cases. */
export async function runTask(params: RunTaskParams): Promise<TaskResult> {
  const { runId, agentName, instanceId, model, provider, prompt, input, registry, limits, clock, control, emit } = params;
  const { abortController } = control;
  const { signal } = abortController;
  const startedAt = clock.now();
  const messages: ProviderMessage[] = [{ role: 'system', text: buildSystemPrompt(prompt) }, { role: 'user', text: buildTaskBrief(input) }];
  const totals: RunTotals = { usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, turns: 0, toolCalls: 0 };
  const errors: ToolErrorDetail[] = [];
  let answer = '';
  let status: TaskStatus = 'completed';
  let failure: string | undefined;

  for (;;) {
    // Covers an abort that landed while tools ran after the stream had already finished.
    if (signal.aborted) { status = abortedStatus(control); break; }
    if (control.isGracefulStopRequested()) { status = 'stopped'; break; }
    if (totals.turns >= limits.maxTurns) { status = 'limit_reached'; break; }
    totals.turns += 1;

    const work: TurnWork = { executions: [], activities: [] };
    let turn: TurnStreamResult;
    try {
      turn = await runTurn({ runId, agentName, instanceId, model, provider, registry, maxToolCalls: limits.maxToolCalls, clock, signal, messages, totals, work, emit });
    } catch (error) {
      if (isAbortError(error, signal)) {
        status = abortedStatus(control);
      } else {
        status = 'failed';
        failure = describeError(error);
        emit({ type: 'error', message: failure });
        // Tools dispatched mid-stream must not outlive a failed run.
        abortController.abort();
      }
      errors.push(...failedDetails(await drainWork(work)));
      break;
    }

    const executed = await drainWork(work);
    messages.push(...turnMessages({ turn, executed }));
    errors.push(...failedDetails(executed));
    if (turn.calls.length === 0) {
      answer = turn.visible.trim();
      if (turn.finishReason === 'length') status = 'incomplete';
      break;
    }
  }

  const { usage, turns, toolCalls } = totals;
  const result: TaskResult = {
    status, answer, runId, agentName, instanceId, errors,
    usage: { ...usage, turns, toolCalls, durationMs: clock.now() - startedAt },
  };
  if (failure != null) result.failure = failure;
  if (status === 'stopped') result.stopMode = 'graceful';
  if (status === 'cancelled') result.stopMode = 'immediate';
  return result;
}
