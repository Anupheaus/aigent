import { toolFailure } from '../../tool-failure.js';

/** One exact-text replacement. */
export interface TextEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

function countOccurrences(params: { text: string; needle: string }): number {
  const { text, needle } = params;
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/**
 * Applies the edits in order to the text in memory. Each `oldText` must occur exactly once (or at least once with
 * `replaceAll`); otherwise nothing is applied and a failure says which edit and why. Returns the new text.
 */
export function applyEdits(params: { text: string; edits: readonly TextEdit[]; path: string }): { text: string; replacements: number } {
  const { edits, path } = params;
  let { text } = params;
  let replacements = 0;
  for (const [index, { oldText, newText, replaceAll = false }] of edits.entries()) {
    if (oldText === '') throw toolFailure({ code: 'empty_match', message: `Edit ${index + 1} for '${path}' has an empty oldText`, suggestion: 'Give the exact text to replace; use fs_write to write a whole file' });
    const found = countOccurrences({ text, needle: oldText });
    if (found === 0) throw toolFailure({ code: 'no_match', message: `Edit ${index + 1} for '${path}': oldText was not found, so no edit was applied`, suggestion: 'Read the file again and copy the exact text (whitespace included)', details: { path, edit: index } });
    if (found > 1 && !replaceAll) throw toolFailure({ code: 'ambiguous_match', message: `Edit ${index + 1} for '${path}': oldText occurs ${found} times, so no edit was applied`, suggestion: 'Include more surrounding text to make it unique, or pass replaceAll: true', details: { path, edit: index, occurrences: found } });
    text = text.split(oldText).join(newText);
    replacements += found;
  }
  return { text, replacements };
}
