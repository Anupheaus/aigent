import { createDirectiveParser } from '../streaming/directive-parser.js';
import type { ParseOutput } from '../streaming/directive-parser.js';
import type { FinishReason, Provider, ProviderMessage, ToolCall, Usage } from '../providers/provider-types.js';
import { executeToolCall, rejectToolCall } from '../tools/execute-tool-call.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { parseToolArgs } from '../tools/parse-tool-args.js';
import { startToolActivity } from '../tools/run-tool-activity.js';
import { describeThrown } from '../tools/tool-error-detail.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { AigentEvent } from './aigent-events.js';
import type { Clock } from './runtime-services.js';

/** Running totals for a whole run; a turn updates them as provider events and tool calls arrive, so partial turns still count. */
export interface RunTotals {
  usage: Usage;
  turns: number;
  /** Tool calls actually started. */
  toolCalls: number;
}

/** Work a turn starts in the background; owned by the caller so it can be drained even when the stream throws. */
export interface TurnWork {
  executions: Promise<ExecutedToolCall>[];
  activities: Promise<void>[];
}

export interface RunTurnParams {
  runId: string;
  agentName: string;
  instanceId: string;
  model: string;
  provider: Provider;
  registry: ToolRegistry;
  maxToolCalls: number;
  clock: Clock;
  signal: AbortSignal;
  /** Conversation so far; copied into the request, never mutated. */
  messages: ProviderMessage[];
  totals: RunTotals;
  work: TurnWork;
  emit(event: AigentEvent): void;
}

export interface TurnStreamResult {
  /** Assistant text with directive lines removed. */
  visible: string;
  /** Tool calls in the order the model made them. */
  calls: ToolCall[];
  finishReason?: FinishReason;
}

interface DispatchParams {
  call: ToolCall;
  turn: RunTurnParams;
}

/** Emits parsed text, directives and warnings; returns the visible text. */
function emitParsed(output: ParseOutput, emit: RunTurnParams['emit']): string {
  const { text, directives, warnings } = output;
  if (text !== '') emit({ type: 'text-delta', text });
  for (const directive of directives) emit({ type: 'directive', directive });
  for (const message of warnings) emit({ type: 'warning', message });
  return text;
}

function addUsage(totals: RunTotals, usage: Usage): void {
  totals.usage.inputTokens += usage.inputTokens;
  totals.usage.outputTokens += usage.outputTokens;
  totals.usage.cachedTokens += usage.cachedTokens;
}

/** Starts (or refuses, past the limit) one tool call without waiting for it, so tools overlap with generation. */
function dispatchToolCall(params: DispatchParams): void {
  const { call, turn } = params;
  const { runId, agentName, instanceId, registry, maxToolCalls, clock, signal, totals, work, emit } = turn;
  const { id: callId, name, args } = call;
  emit({ type: 'tool-call', callId, name, args });
  const reportResult = (executed: ExecutedToolCall): ExecutedToolCall => {
    emit({ type: 'tool-result', callId, envelope: executed.envelope });
    return executed;
  };

  if (totals.toolCalls >= maxToolCalls) {
    const error = { category: 'denied', code: 'tool_call_limit', retryable: false, message: `Tool call limit of ${maxToolCalls} reached` } as const;
    work.executions.push(Promise.resolve(rejectToolCall({ call, error })).then(reportResult));
    return;
  }

  totals.toolCalls += 1;
  // executeToolCall promises never to reject; this last-resort guard keeps a broken promise from failing the run or going unhandled.
  const execution = executeToolCall({ registry, call, context: { agentName, instanceId, runId, signal }, now: () => clock.now() })
    .catch((error: unknown) => rejectToolCall({ call, error: describeThrown(error) }));
  work.executions.push(execution.then(reportResult));

  const tool = registry.get(name);
  if (tool == null) return;
  const parsed = parseToolArgs(tool.argsSchema, args);
  if (!parsed.ok) return;
  const outcome = execution.then(executed => executed.outcome);
  work.activities.push(startToolActivity({ tool, args: parsed.value, callId, outcome, emit }));
}

/** Streams one model response, emitting events and dispatching tool calls as they arrive. Throws if the stream fails or aborts. */
export async function runTurn(params: RunTurnParams): Promise<TurnStreamResult> {
  const { model, provider, registry, signal, messages, totals, emit } = params;
  const parser = createDirectiveParser();
  const calls: ToolCall[] = [];
  let visible = '';
  let finishReason: FinishReason | undefined;

  for await (const event of provider.stream({ model, messages: [...messages], tools: registry.specs() }, signal)) {
    switch (event.type) {
      case 'text-delta': visible += emitParsed(parser.push(event.text), emit); break;
      case 'thinking-delta': emit(event); break;
      case 'tool-call': calls.push(event.call); dispatchToolCall({ call: event.call, turn: params }); break;
      case 'usage': addUsage(totals, event.usage); emit(event); break;
      case 'done': finishReason = event.finishReason; break;
    }
  }
  visible += emitParsed(parser.end(), emit);
  return { visible, calls, finishReason };
}
