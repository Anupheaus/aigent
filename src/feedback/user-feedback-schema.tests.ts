import { describe, expect, it } from 'vitest';
import { parseUserFeedback } from './user-feedback-schema.js';

describe('parseUserFeedback', () => {
  it.each([
    [{ responseId: 'resp_1', rating: 'correct' }],
    [{ responseId: 'resp_1', rating: 'incorrect', comment: 'Wrong file', expectedAnswer: 'src/theme.ts' }],
    [{ responseId: 'resp_1', rating: 'partial', comment: 'c'.repeat(2_000), expectedAnswer: 'e'.repeat(10_000) }],
  ])('accepts %j', feedback => {
    expect(parseUserFeedback(feedback)).toEqual(feedback);
  });

  it.each([
    [{ rating: 'correct' }, 'responseId'],
    [{ responseId: '', rating: 'correct' }, 'responseId'],
    [{ responseId: 'resp_1' }, 'rating'],
    [{ responseId: 'resp_1', rating: 'great' }, 'rating'],
    [{ responseId: 'resp_1', rating: 'correct', comment: 'c'.repeat(2_001) }, 'comment'],
    [{ responseId: 'resp_1', rating: 'correct', expectedAnswer: 'e'.repeat(10_001) }, 'expectedAnswer'],
    [{ responseId: 'resp_1', rating: 'correct', score: 5 }, 'score'],
    ['correct', '(root)'],
  ])('rejects %j with invalid_input naming %s', (feedback, field) => {
    expect(() => parseUserFeedback(feedback)).toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringMatching(new RegExp(`^Invalid feedback: .*${field.replace(/[()]/g, '\\$&')}`)) }));
  });
});
