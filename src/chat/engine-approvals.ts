import type { ApprovalCenter } from '../approvals/approval-gate.js';
import type { IdGenerator } from '../core/runtime-services.js';
import type { PendingTurn } from './pending-turn.js';
import type { SuspendedTurns } from './suspended-turns.js';
import { createTurnHandle } from './turn-handle.js';

/** The text recorded as the task of a turn continued by an approval decision. */
const APPROVED_TASK_TEXT = 'Approval decided';

export interface ResumeOnDecisionParams {
  suspended: SuspendedTurns;
  approvals: ApprovalCenter;
  ids: IdGenerator;
  /** Starts (or queues) the continued turn. */
  accept(pending: PendingTurn): void;
}

/**
 * A reopened session whose turn was waiting for an approval when its process stopped: the request is restored (so
 * `agent.approve` accepts it), and the decision continues the turn from its checkpoint, where the gate finds it.
 */
export function resumeOnDecision(params: ResumeOnDecisionParams): void {
  const { suspended, approvals, ids, accept } = params;
  const restored = suspended.restoredApproval();
  if (restored == null) return;
  const { turn, runId, states } = restored;
  const requestId = turn.approvalRequestId;
  if (requestId == null) return;
  approvals.restorePending({ runId, states });
  approvals.onDecided(requestId, () => {
    const agentMessageId = ids.next('msg');
    accept({ agentMessageId, handle: createTurnHandle(agentMessageId), replyTo: turn.agentMessageId, taskText: APPROVED_TASK_TEXT, restore: suspended.restoreAfterApproval(turn) });
  });
}
