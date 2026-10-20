import { describe, expect, it } from 'vitest';
import { FEEDBACK_PROMPT_ADDENDUM } from './feedback-prompt.js';

/** The addendum is sent with every request, so it must stay tiny. */
const MAX_ADDENDUM_LENGTH = 900;

describe('FEEDBACK_PROMPT_ADDENDUM', () => {
  it('describes previous, aigent_feedback and the outcome and status directives, briefly', () => {
    for (const phrase of ['"previous"', 'null on your first', 'aigent_feedback', '::aigent outcome', '::aigent status']) expect(FEEDBACK_PROMPT_ADDENDUM).toContain(phrase);
    expect(FEEDBACK_PROMPT_ADDENDUM.length).toBeLessThan(MAX_ADDENDUM_LENGTH);
  });
});
