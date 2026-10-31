/**
 * Appended to the library rules only when memory is enabled. Fixed text, so the system prompt prefix stays byte-stable
 * and cacheable.
 */
export const MEMORY_PROMPT_ADDENDUM = [
  '# Memory',
  'Tool calls have a "memory" field for durable notes worth keeping for later runs: a stable fact, a user preference, a lesson learnt or a working procedure. Each note is {"kind", "text" (at most 300 characters), "tags" (at most 5, each at most 24 characters, or null), "pinned" (true only for notes that must never be dropped, else null)}. Send null unless something is worth remembering; never note secrets or one-off details.',
].join('\n');
