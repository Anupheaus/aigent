import { describe, expect, it } from 'vitest';
import type { JsonValue, Question } from './message.js';
import { answerBatch, batchResults, createQuestionBatch, isBatchComplete, validateAnswer } from './question-state.js';

const OPTIONS = [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }, { value: 'green', label: 'Green' }];
const TEXT: Question = { id: 'name', text: 'Name?', type: 'text', required: true, min: 2, max: 5 };
const NUMBER: Question = { id: 'age', text: 'Age?', type: 'number', required: true, min: 0, max: 130 };
const CONFIRM: Question = { id: 'ok', text: 'Proceed?', type: 'confirm', required: true };
const SINGLE: Question = { id: 'colour', text: 'Colour?', type: 'single_choice', required: true, options: OPTIONS };
const MULTI: Question = { id: 'colours', text: 'Colours?', type: 'multi_choice', required: false, options: OPTIONS, min: 1, max: 2 };

describe('validateAnswer', () => {
  it.each<[Question, JsonValue, JsonValue]>([
    [TEXT, 'Ada', 'Ada'],
    [NUMBER, 42, 42],
    [NUMBER, ' 7 ', 7],
    [CONFIRM, true, true],
    [CONFIRM, 'Yes', true],
    [CONFIRM, 'no', false],
    [SINGLE, 'blue', 'blue'],
    [SINGLE, 'Green', 'green'],
    [MULTI, ['red', 'blue'], ['red', 'blue']],
    [MULTI, 'red, Green', ['red', 'green']],
  ])('accepts %o answered with %o', (question, value, expected) => {
    expect(validateAnswer({ question, value })).toEqual({ ok: true, value: expected });
  });

  it.each<[Question, JsonValue, RegExp]>([
    [TEXT, 'A', /at least 2 characters/],
    [TEXT, 'Adalbert', /at most 5 characters/],
    [TEXT, '', /required/],
    [TEXT, 3, /expected text/],
    [NUMBER, 'many', /expected a number/],
    [NUMBER, 200, /at most 130/],
    [CONFIRM, 'perhaps', /expected yes or no/],
    [SINGLE, 'purple', /one of red, blue, green/],
    [MULTI, ['red', 'blue', 'green'], /at most 2 choices/],
    [MULTI, ['red', 'red'], /repeats 'red'/],
    [MULTI, [], /at least 1 choice/],
  ])('rejects %o answered with %o, saying why', (question, value, message) => {
    const result = validateAnswer({ question, value });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(message);
    expect(result.ok ? '' : result.error).toContain(`'${question.id}'`);
  });
});

describe('question batches', () => {
  it('completes once every required question is answered and reports each question precisely', () => {
    let batch = createQuestionBatch({ callId: 'c1', questions: [TEXT, NUMBER, MULTI] });
    batch = answerBatch(batch, { questionId: 'name', value: 'Ada' });
    expect(isBatchComplete(batch)).toBe(false);
    batch = answerBatch(batch, { questionId: 'age', value: 36 });
    expect(isBatchComplete(batch)).toBe(true);
    expect(batchResults(batch)).toEqual([
      { id: 'name', ok: true, value: 'Ada' },
      { id: 'age', ok: true, value: 36 },
      { id: 'colours', ok: false, value: null, error: 'not answered' },
    ]);
  });

  it('a batch of optional questions completes on the first answer', () => {
    const batch = answerBatch(createQuestionBatch({ callId: 'c1', questions: [MULTI] }), { questionId: 'colours', value: ['red'] });
    expect(isBatchComplete(batch)).toBe(true);
  });
});
