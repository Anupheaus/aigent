import { toolFailure } from '../../tool-failure.js';
import type { EditableText } from './fs-text-codec.js';

/** One exact-text replacement. */
export interface TextEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

/** Where `needle` occurs in `text`, left to right without overlaps (as `split` cuts it). */
function occurrences(params: { text: string; needle: string }): number[] {
  const { text, needle } = params;
  const found: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

/**
 * Replaces the ranges at `positions` (each `length` long) with `newText` in one linear pass, keeping the recorded CRLF
 * positions of the text in between; line breaks in `newText` are recorded as CRLF when `asCrlf`.
 */
function replaceAt(params: { doc: EditableText; positions: number[]; length: number; newText: string; asCrlf: boolean }): EditableText {
  const { doc: { text, crlf }, positions, length, newText, asCrlf } = params;
  const pieces: string[] = [];
  const kept: number[] = [];
  let written = 0;
  let next = 0;
  const copy = (start: number, end: number): void => {
    // Recorded CRLFs inside a replaced range are skipped here, because `start` has moved past them.
    for (; next < crlf.length && (crlf[next] ?? 0) < end; next += 1) if ((crlf[next] ?? 0) >= start) kept.push((crlf[next] ?? 0) - start + written);
    pieces.push(text.slice(start, end));
    written += end - start;
  };
  let from = 0;
  for (const at of positions) {
    copy(from, at);
    if (asCrlf) for (let newline = newText.indexOf('\n'); newline !== -1; newline = newText.indexOf('\n', newline + 1)) kept.push(written + newline);
    pieces.push(newText);
    written += newText.length;
    from = at + length;
  }
  copy(from, text.length);
  return { text: pieces.join(''), crlf: kept };
}

/**
 * Applies the edits in order to the document in memory. Each `oldText` must occur exactly once (or at least once with
 * `replaceAll`); otherwise nothing is applied and a failure says which edit and why. Text outside the replaced ranges
 * keeps its line endings exactly; line breaks the edits write use CRLF when `asCrlf` (the file's usual ending).
 */
export function applyEdits(params: { doc: EditableText; edits: readonly TextEdit[]; path: string; asCrlf?: boolean }): { doc: EditableText; replacements: number } {
  const { edits, path, asCrlf = false } = params;
  let { doc } = params;
  let replacements = 0;
  for (const [index, { oldText, newText, replaceAll = false }] of edits.entries()) {
    if (oldText === '') throw toolFailure({ code: 'empty_match', message: `Edit ${index + 1} for '${path}' has an empty oldText`, suggestion: 'Give the exact text to replace; use fs_write to write a whole file' });
    const positions = occurrences({ text: doc.text, needle: oldText });
    if (positions.length === 0) throw toolFailure({ code: 'no_match', message: `Edit ${index + 1} for '${path}': oldText was not found, so no edit was applied`, suggestion: 'Read the file again and copy the exact text (whitespace included)', details: { path, edit: index } });
    if (positions.length > 1 && !replaceAll) throw toolFailure({ code: 'ambiguous_match', message: `Edit ${index + 1} for '${path}': oldText occurs ${positions.length} times, so no edit was applied`, suggestion: 'Include more surrounding text to make it unique, or pass replaceAll: true', details: { path, edit: index, occurrences: positions.length } });
    doc = replaceAt({ doc, positions, length: oldText.length, newText, asCrlf });
    replacements += positions.length;
  }
  return { doc, replacements };
}
