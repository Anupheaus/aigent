/**
 * The regex worker's code, run with `new Worker(source, { eval: true })` so it needs no separate file in `dist` or
 * under vitest. It compiles the pattern it is sent and matches it against each text in order; the main thread
 * terminates the worker when a job overruns its deadline, which is what bounds a catastrophic pattern.
 *
 * A job is `{ id, pattern, flags, texts, keep, countAll }`; the reply is `{ id, ok: true, count, matches, isComplete }`
 * (each match `{ text, index, match, captures, groups }`) or `{ id, ok: false, message }`.
 */
export const REGEX_WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const groupsOf = found => found.groups == null ? null : Object.fromEntries(Object.entries(found.groups).map(([name, value]) => [name, value ?? null]));
parentPort.on('message', ({ id, pattern, flags, texts, keep, countAll }) => {
  try {
    const regex = new RegExp(pattern, flags);
    const matches = [];
    let count = 0;
    let isComplete = true;
    outer: for (let text = 0; text < texts.length; text += 1) {
      for (const found of texts[text].matchAll(regex)) {
        if (found[0] === '') continue;
        if (matches.length >= keep && !countAll) { isComplete = false; break outer; }
        count += 1;
        if (matches.length < keep) matches.push({ text, index: found.index, match: found[0], captures: found.slice(1).map(capture => capture ?? null), groups: groupsOf(found) });
      }
    }
    parentPort.postMessage({ id, ok: true, count, matches, isComplete });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
`;
