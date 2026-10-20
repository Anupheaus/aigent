import type { AigentEvent } from '../core/aigent-events.js';
import type { IdGenerator } from '../core/runtime-services.js';
import { summariseArgs } from '../telemetry/summarise-args.js';
import type { PatchLog } from './apply-patch.js';
import { toolActivityMessage } from './message-builders.js';
import type { Message, Part } from './message.js';

export interface TurnRecorderParams {
  log: PatchLog;
  ids: IdGenerator;
  /** The agent message the reply streams into. */
  messageId: string;
  /** The message being answered. */
  replyTo: string;
  branchId: string;
  threadId?: string;
  now(): number;
}

/** Mirrors one run's events into the conversation: streamed text, tool rows per model request, thinking, plan and activity. */
export interface TurnRecorder {
  observe(params: { event: AigentEvent; runId: string }): void;
  /** Closes the tool rows still streaming. */
  close(): void;
}

function find(log: PatchLog, messageId: string): Message | undefined {
  return log.state().messages.find(({ id }) => id === messageId);
}

function resultSummary(event: Extract<AigentEvent, { type: 'tool-result' }>): string {
  const { envelope } = event;
  return envelope.ok ? summariseArgs({ args: envelope.result, captureContent: true }) : envelope.error.message;
}

export function createTurnRecorder(params: TurnRecorderParams): TurnRecorder {
  const { log, ids, messageId, replyTo, branchId, threadId, now } = params;
  /** The tool rows of the current model request; a new request starts a new row group. */
  let round: string | undefined;
  const rounds: string[] = [];

  function addParts(params: { id: string; parts: Part[] }): void {
    const message = find(log, params.id);
    if (message == null) return;
    log.append({ type: 'message-updated', messageId: params.id, set: { parts: [...message.parts, ...params.parts] } });
  }

  function toolRow(runId: string): string {
    if (round != null) return round;
    const id = ids.next('msg');
    log.append({ type: 'message-added', message: toolActivityMessage({ id, branchId, createdAt: now(), runId, replyTo, ...(threadId == null ? {} : { threadId }) }) });
    round = id;
    rounds.push(id);
    return id;
  }

  function observe(observed: { event: AigentEvent; runId: string }): void {
    const { event, runId } = observed;
    switch (event.type) {
      case 'text-delta': log.append({ type: 'message-updated', messageId, partIndex: 0, delta: event.text }); break;
      case 'thinking-done': addParts({ id: messageId, parts: [{ type: 'thinking', text: event.text }] }); break;
      case 'tool-call': addParts({ id: toolRow(runId), parts: [{ type: 'tool_call', callId: event.callId, name: event.name, argsSummary: summariseArgs({ args: event.args, captureContent: true }) }] }); break;
      case 'tool-result': {
        const row = rounds.find(id => find(log, id)?.parts.some(part => part.type === 'tool_call' && part.callId === event.callId));
        if (row != null) addParts({ id: row, parts: [{ type: 'tool_result', callId: event.callId, ok: event.envelope.ok, summary: resultSummary(event) }] });
        break;
      }
      // A model request ended; the next request's calls get rows of their own.
      case 'usage': round = undefined; break;
      case 'plan-update': log.append({ type: 'plan-updated', items: event.items }); break;
      case 'todo-update': log.append({ type: 'todo-updated', items: event.items }); break;
      case 'activity': log.append({ type: 'activity-updated', activity: event.update }); break;
      default: break;
    }
  }

  function close(): void {
    const at = now();
    for (const id of rounds) if (find(log, id)?.state === 'streaming') log.append({ type: 'message-updated', messageId: id, set: { state: 'complete', completedAt: at } });
  }

  return { observe, close };
}
