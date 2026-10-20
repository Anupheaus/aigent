import { createAigentError } from '../../core/aigent-error.js';

function csvError(params: { reason: string; message: string; line: number; column: number }): Error {
  const { reason, message, line, column } = params;
  return createAigentError({ code: 'invalid_input', message: `CSV ${message} at line ${line}, column ${column}`, details: { reason, line, column } });
}

/**
 * Parses CSV text (RFC 4180): fields separated by `delimiter` (default `,`), records by LF or CRLF, double-quoted fields
 * may hold delimiters, line breaks and doubled quotes (`""`). A leading BOM is dropped and a final line break ends the
 * last record. Throws `invalid_input` (with `details.reason`, `line`, `column`) for an unterminated quote or text after
 * a closing quote.
 */
export function parseCsv(params: { text: string; delimiter?: string }): string[][] {
  const { delimiter = ',' } = params;
  const text = params.text.startsWith('﻿') ? params.text.slice(1) : params.text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  /** Something (even an empty quoted value) belongs to the current field. */
  let isFieldStarted = false;
  let index = 0;
  let line = 1;
  let lineStart = 0;
  const endField = (): void => { row.push(field); field = ''; isFieldStarted = false; };
  const endRow = (): void => { endField(); rows.push(row); row = []; };
  const isRecordEnd = (at: number): boolean => text[at] === '\n' || (text[at] === '\r' && text[at + 1] === '\n');
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '"' && !isFieldStarted) {
      const quote = { line, column: index - lineStart + 1 };
      isFieldStarted = true;
      index += 1;
      for (;;) {
        if (index >= text.length) throw csvError({ reason: 'unterminated_quote', message: 'has a quoted field that is never closed', ...quote });
        const inner = text[index] ?? '';
        if (inner === '"' && text[index + 1] === '"') { field += '"'; index += 2; continue; }
        if (inner === '"') { index += 1; break; }
        if (inner === '\n') { line += 1; lineStart = index + 1; }
        field += inner;
        index += 1;
      }
      if (index < text.length && text[index] !== delimiter && !isRecordEnd(index)) {
        throw csvError({ reason: 'text_after_quote', message: 'has text after a closing quote', line, column: index - lineStart + 1 });
      }
      continue;
    }
    if (char === delimiter) { endField(); index += 1; continue; }
    if (isRecordEnd(index)) { endRow(); index += char === '\r' ? 2 : 1; line += 1; lineStart = index; continue; }
    field += char;
    isFieldStarted = true;
    index += 1;
  }
  if (isFieldStarted || row.length > 0) endRow();
  return rows;
}
