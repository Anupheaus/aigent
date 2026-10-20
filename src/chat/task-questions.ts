import type { JsonValue, Question } from './message.js';
import type { AskUser } from './ask-user-tool.js';
import { validateAnswer } from './question-state.js';
import type { QuestionResult } from './question-state.js';

/** Answers keyed by question id, as `TaskInput.onQuestion` returns them. */
export type AnswerSet = Record<string, JsonValue>;

/** `TaskInput.onQuestion`: a user attached to a task answers `ask_user` batches. */
export type OnQuestion = (questions: Question[]) => Promise<AnswerSet>;

function resultFor(params: { question: Question; answers: AnswerSet }): QuestionResult {
  const { question, answers } = params;
  const { id } = question;
  const value = answers[id];
  if (value === undefined) return { id, ok: false, value: null, error: 'not answered' };
  const check = validateAnswer({ question, value });
  return check.ok ? { id, ok: true, value: check.value } : { id, ok: false, value: null, error: check.error };
}

/** The task-mode `ask_user` handler: the callback answers, each answer is validated like a chat answer. */
export function askThrough(onQuestion: OnQuestion): AskUser {
  return async ({ questions }) => {
    const answers = await onQuestion(questions);
    return questions.map(question => resultFor({ question, answers }));
  };
}
