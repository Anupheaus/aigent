import type { Shaper } from '../shaper-types.js';

/** Identical consecutive lines folded into one. */
const MIN_REPEATS = 3;

function foldLines(lines: string[]): string[] {
  const folded: string[] = [];
  for (let start = 0; start < lines.length;) {
    const line = lines[start] as string;
    let end = start + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const count = end - start;
    if (count >= MIN_REPEATS) folded.push(`${line} (x${count})`);
    else folded.push(...lines.slice(start, end));
    start = end;
  }
  return folded;
}

/** log, command-output: three or more identical consecutive lines become `line (xN)`. */
export const foldRepeatsShaper: Shaper = {
  name: 'fold-repeats',
  appliesTo: ['log', 'command-output'],
  shape: ({ value, context }) => {
    if (typeof value !== 'string') return undefined;
    const lines = value.split('\n');
    const folded = foldLines(lines);
    if (folded.length === lines.length) return undefined;
    return { value: folded.join('\n'), note: `Repeated lines folded as "line (xN)"; full output: handle ${context.originalHandle()}` };
  },
};
