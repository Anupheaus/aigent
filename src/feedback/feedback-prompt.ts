/**
 * Appended to the library rules only when feedback is enabled. Fixed text, so the system prompt prefix stays
 * byte-stable and cacheable.
 */
export const FEEDBACK_PROMPT_ADDENDUM = [
  '# Feedback',
  'Every top-level tool call (not calls inside aigent_multi, and not aigent_feedback, plan_complete or todo) has a "previous" field: how your previous tool step went, as {"success": true or false, "answer": "short result, at most 300 characters"}. success means it found what you were looking for. Send null on your first tool call.',
  'You may report that sooner, and show progress, with single-line directives on their own line: ::aigent outcome {"success":true,"answer":"short result of the previous step"} and ::aigent status {"text":"short status"}. They are not shown to the user.',
  'When something was easy, hard, missing or could be simpler, call aigent_feedback alongside your other tool calls; never spend a turn on it alone.',
].join('\n');
