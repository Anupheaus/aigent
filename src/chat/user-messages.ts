import type { PatchLog } from './apply-patch.js';
import { userMessage } from './message-builders.js';
import { deliveryMeta } from './pending-turn.js';
import type { PendingTurn } from './pending-turn.js';
import type { TurnRunControl } from './turn-handle.js';

/** Adds a starting turn's user message (with how it was delivered); a turn without one adds nothing. */
export function recordUserMessage(params: { log: PatchLog; pending: PendingTurn; now: number }): void {
  const { log, pending, now } = params;
  const { user, threadId } = pending;
  if (user == null) return;
  const { id, text, modelText, compactable, parts, attachments } = user;
  const delivery = deliveryMeta({ pending, startedAt: now });
  log.append({
    type: 'message-added',
    message: userMessage({
      id, text, modelText, branchId: log.state().branchId, createdAt: now, ...(delivery == null ? {} : { delivery }), ...(compactable == null ? {} : { compactable }),
      ...(parts == null ? {} : { extraParts: parts }), ...(attachments == null ? {} : { attachments }), ...(threadId == null ? {} : { threadId, replyTo: pending.replyTo ?? threadId }),
    }),
  });
}

export interface RecordSteeredParams {
  log: PatchLog;
  now(): number;
  /** The running reply the messages joined. */
  control: TurnRunControl;
  agentMessageId: string;
  delivered: PendingTurn[];
}

/**
 * Steered messages join the running reply at its safe boundary: they are recorded there (without a history of their
 * own: the model saw them inside the reply's history), and their handles follow the reply.
 */
export function recordSteered(params: RecordSteeredParams): void {
  const { log, now, control, agentMessageId, delivered } = params;
  for (const pending of delivered) {
    if (pending.user == null) continue;
    const createdAt = now();
    log.append({ type: 'message-added', message: userMessage({ id: pending.user.id, text: pending.user.text, branchId: log.state().branchId, createdAt, delivery: { mode: 'steer', steered: true, startedAt: createdAt }, compactable: false }) });
    pending.handle.setMessageId(agentMessageId);
    pending.handle.attach(control);
  }
}
