import type { JsonValue, Question } from './message.js';

export type AnswerCheck = { ok: true; value: JsonValue } | { ok: false; error: string };

/** One question's outcome, as the `ask_user` result gives it to the model. */
export interface QuestionResult {
  id: string;
  ok: boolean;
  value: JsonValue;
  error?: string;
}

/** One `ask_user` call's questions and the answers given so far. */
export interface QuestionBatch {
  callId: string;
  questions: Question[];
  answers: Record<string, JsonValue>;
}

const YES = new Set(['yes', 'y', 'true']);
const NO = new Set(['no', 'n', 'false']);

function fail(question: Question, reason: string): AnswerCheck {
  return { ok: false, error: `Answer to question '${question.id}' (${question.type}) is invalid: ${reason}` };
}

function bounds(params: { question: Question; size: number; unit: string }): AnswerCheck | undefined {
  const { question, size, unit } = params;
  const { min, max } = question;
  if (min != null && size < min) return fail(question, `needs at least ${min} ${unit}, got ${size}`);
  if (max != null && size > max) return fail(question, `allows at most ${max} ${unit}, got ${size}`);
  return undefined;
}

/** An option by value or (case-insensitive) label. */
function findOption(question: Question, raw: string): string | undefined {
  const wanted = raw.trim().toLowerCase();
  return question.options?.find(({ value, label }) => value.toLowerCase() === wanted || label.toLowerCase() === wanted)?.value;
}

function optionList(question: Question): string {
  return (question.options ?? []).map(({ value }) => value).join(', ');
}

function checkText(question: Question, value: JsonValue): AnswerCheck {
  if (typeof value !== 'string') return fail(question, `expected text, got ${JSON.stringify(value)}`);
  if (question.required && value.trim() === '') return fail(question, 'an answer is required');
  return bounds({ question, size: value.length, unit: 'characters' }) ?? { ok: true, value };
}

function checkNumber(question: Question, value: JsonValue): AnswerCheck {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fail(question, `expected a number, got ${JSON.stringify(value)}`);
  const { min, max } = question;
  if (min != null && parsed < min) return fail(question, `must be at least ${min}, got ${parsed}`);
  if (max != null && parsed > max) return fail(question, `must be at most ${max}, got ${parsed}`);
  return { ok: true, value: parsed };
}

function checkConfirm(question: Question, value: JsonValue): AnswerCheck {
  if (typeof value === 'boolean') return { ok: true, value };
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (YES.has(text)) return { ok: true, value: true };
  if (NO.has(text)) return { ok: true, value: false };
  return fail(question, `expected yes or no, got ${JSON.stringify(value)}`);
}

function checkSingle(question: Question, value: JsonValue): AnswerCheck {
  const option = typeof value === 'string' ? findOption(question, value) : undefined;
  return option == null ? fail(question, `expected one of ${optionList(question)}, got ${JSON.stringify(value)}`) : { ok: true, value: option };
}

function checkMulti(question: Question, value: JsonValue): AnswerCheck {
  const raw = typeof value === 'string' ? value.split(',').filter(part => part.trim() !== '') : value;
  if (!Array.isArray(raw) || !raw.every(entry => typeof entry === 'string')) return fail(question, `expected a list of choices, got ${JSON.stringify(value)}`);
  const chosen: string[] = [];
  for (const entry of raw as string[]) {
    const option = findOption(question, entry);
    if (option == null) return fail(question, `'${entry}' is not one of ${optionList(question)}`);
    if (chosen.includes(option)) return fail(question, `repeats '${option}'`);
    chosen.push(option);
  }
  if (question.required && chosen.length === 0) return fail(question, 'an answer is required');
  return bounds({ question, size: chosen.length, unit: 'choices' }) ?? { ok: true, value: chosen };
}

/** Checks (and normalises) an answer against its question's type and constraints, saying precisely what is wrong. */
export function validateAnswer(params: { question: Question; value: JsonValue }): AnswerCheck {
  const { question, value } = params;
  switch (question.type) {
    case 'text': return checkText(question, value);
    case 'number': return checkNumber(question, value);
    case 'confirm': return checkConfirm(question, value);
    case 'single_choice': return checkSingle(question, value);
    case 'multi_choice': return checkMulti(question, value);
  }
}

export function createQuestionBatch(params: { callId: string; questions: Question[] }): QuestionBatch {
  return { ...params, answers: {} };
}

/** Records an already validated answer. */
export function answerBatch(batch: QuestionBatch, answer: { questionId: string; value: JsonValue }): QuestionBatch {
  return { ...batch, answers: { ...batch.answers, [answer.questionId]: answer.value } };
}

/** Every required question is answered (a batch with none required: any one is). */
export function isBatchComplete(batch: QuestionBatch): boolean {
  const { questions, answers } = batch;
  const required = questions.filter(({ required: isRequired }) => isRequired);
  if (required.length === 0) return Object.keys(answers).length > 0;
  return required.every(({ id }) => id in answers);
}

/** The per-question results the model receives when the batch completes. */
export function batchResults(batch: QuestionBatch): QuestionResult[] {
  return batch.questions.map(({ id }) => (id in batch.answers ? { id, ok: true, value: batch.answers[id] ?? null } : { id, ok: false, value: null, error: 'not answered' }));
}
