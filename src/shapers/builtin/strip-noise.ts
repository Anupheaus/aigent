import type { Shaper } from '../shaper-types.js';
import { mapCommandOutput } from './command-text.js';

/** CSI sequences (colours, cursor moves) and OSC sequences (window titles) terminals interpret. */
const ANSI_ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** Blank lines kept in a row; longer runs are cut to this. */
const MAX_BLANK_LINES = 2;

/** The text a terminal would finally show on a line: what follows its last carriage return (progress bars overwrite). */
function finalLine(line: string): string {
  const withoutLineEnd = line.endsWith('\r') ? line.slice(0, -1) : line;
  const lastReturn = withoutLineEnd.lastIndexOf('\r');
  return (lastReturn === -1 ? withoutLineEnd : withoutLineEnd.slice(lastReturn + 1)).trimEnd();
}

function capBlankRuns(lines: string[]): string[] {
  const kept: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    blankRun = line === '' ? blankRun + 1 : 0;
    if (blankRun <= MAX_BLANK_LINES) kept.push(line);
  }
  return kept;
}

/** command-output: ANSI escapes, carriage-return progress overwrites, trailing whitespace and long blank runs. */
export const stripNoiseShaper: Shaper = {
  name: 'strip-noise',
  appliesTo: ['command-output'],
  shape: ({ value, context }) => {
    // A string result, or the stdout/stderr of structured ones (results marked raw: true are left alone).
    const cleaned = mapCommandOutput({ value, clean: text => capBlankRuns(text.replace(ANSI_ESCAPES, '').split('\n').map(finalLine)).join('\n') });
    if (cleaned === undefined) return undefined;
    return { value: cleaned, note: `Terminal noise removed (ANSI escapes, progress overwrites, trailing whitespace, extra blank lines); full output: handle ${context.originalHandle()}` };
  },
};
