import { createAigentError } from '../core/aigent-error.js';
import type { UserFeedback } from '../feedback/feedback-records.js';
import type { PatchLog } from './apply-patch.js';
import { lineage } from './lineage.js';

export type SubmitFeedback = (feedback: UserFeedback) => Promise<void>;

/** `chat.feedback`: rates a reply (the latest on the active branch when `responseId` is omitted). */
export async function rateReply(params: { log: PatchLog; submit: SubmitFeedback; feedback: Omit<UserFeedback, 'responseId'> & { responseId?: string } }): Promise<void> {
  const { log, submit, feedback } = params;
  const latest = [...lineage({ state: log.state() })].reverse().find(({ meta }) => meta.responseId != null)?.meta.responseId;
  const responseId = feedback.responseId ?? latest;
  if (responseId == null) throw createAigentError({ code: 'invalid_input', message: `Chat session '${log.state().sessionId}' has no reply to rate yet`, details: { sessionId: log.state().sessionId } });
  await submit({ ...feedback, responseId });
}

/** `chat.react`: sugar for `ai.feedback` on the reply's response id (up = correct, down = incorrect), noted in its meta. */
export async function reactTo(params: { log: PatchLog; submit: SubmitFeedback; messageId: string; rating: 'up' | 'down'; comment?: string }): Promise<void> {
  const { log, submit, messageId, rating, comment } = params;
  const message = log.state().messages.find(({ id }) => id === messageId);
  const responseId = message?.meta.responseId;
  if (message == null || responseId == null) {
    throw createAigentError({ code: 'invalid_input', message: `Cannot react to message '${messageId}' in session '${log.state().sessionId}': it is not a finished agent reply`, details: { messageId } });
  }
  await submit({ responseId, rating: rating === 'up' ? 'correct' : 'incorrect', ...(comment == null ? {} : { comment }) });
  // Read again: the message may have changed while the feedback was stored.
  const { meta } = log.state().messages.find(({ id }) => id === messageId) ?? message;
  log.append({ type: 'message-updated', messageId, set: { meta: { ...meta, userRating: rating } } });
}
