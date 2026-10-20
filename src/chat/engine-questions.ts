import type { IdGenerator } from '../core/runtime-services.js';
import type { PatchLog } from './apply-patch.js';
import { createChatQuestions } from './chat-questions.js';
import type { ChatQuestions } from './chat-questions.js';
import type { PendingTurn } from './pending-turn.js';
import { batchResultsFrom } from './suspended-turns.js';
import type { SuspendedTurns } from './suspended-turns.js';
import { createTurnHandle } from './turn-handle.js';
import type { TurnHandle, TurnRunControl } from './turn-handle.js';

export interface EngineQuestionsParams {
  log: PatchLog;
  ids: IdGenerator;
  now(): number;
  setStatus(status: 'running' | 'waiting_for_user'): void;
  /** Starts (or queues) a turn. */
  accept(pending: PendingTurn): void;
  /** The running turn's control, when one runs. */
  activeControl(): TurnRunControl | undefined;
  suspended?: SuspendedTurns;
}

/** A turn handle following a new agent message (the caller's, when it already has one). */
function handleFor(params: { ids: IdGenerator; given?: TurnHandle }): { agentMessageId: string; handle: TurnHandle } {
  const { ids, given } = params;
  const agentMessageId = ids.next('msg');
  const handle = given ?? createTurnHandle(agentMessageId);
  handle.setMessageId(agentMessageId);
  return { agentMessageId, handle };
}

/**
 * The chat's `ask_user` questions wired to its engine: a batch answered after its turn was gone continues the
 * suspended turn from its checkpoint when one was recorded, and otherwise starts a fresh turn that sees the answers.
 */
export function createEngineQuestions(params: EngineQuestionsParams): ChatQuestions {
  const { log, ids, now, setStatus, accept, activeControl, suspended } = params;
  return createChatQuestions({
    log, ids, now, setStatus,
    resumeInFreshTurn: ({ replyTo, taskText, handle: given }) => {
      const { agentMessageId, handle } = handleFor({ ids, ...(given == null ? {} : { given }) });
      accept({ agentMessageId, handle, replyTo, taskText });
      return handle;
    },
    onSuspend: ({ callId, place: { agentMessageId } }) => {
      const control = activeControl();
      if (control != null) suspended?.suspend({ runId: control.streamId ?? control.runId, callId, agentMessageId, patchSeq: log.state().seq });
    },
    resumeSuspended: ({ callId, replyTo, handle: given }) => {
      const turn = suspended?.find(callId);
      if (suspended == null || turn == null) return undefined;
      const { agentMessageId, handle } = handleFor({ ids, ...(given == null ? {} : { given }) });
      const restore = suspended.restoreWith({ turn, results: batchResultsFrom({ state: log.state(), callId }) });
      accept({ agentMessageId, handle, replyTo, taskText: 'Answers to your questions', restore });
      return handle;
    },
  });
}
