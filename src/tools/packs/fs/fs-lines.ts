import type { FsFileHandle } from '../../../security/fs-access.js';
import { BINARY_SAMPLE_BYTES, cutLongLine, decoderFor, encodingOf, isBinary, mimeGuess } from './fs-text.js';
import type { TextEncoding } from './fs-text.js';

/** Bytes read from disk at a time while scanning a file for lines. */
const CHUNK_BYTES = 65_536;
/** A file up to this size is scanned to the end, so `totalLines` is known even when only a window is returned. */
const MAX_COUNTED_BYTES = 32 * 1_048_576;

export interface ReadLinesParams {
  /** An open (and verified) handle; the caller closes it. */
  handle: FsFileHandle;
  /** File size in bytes. */
  size: number;
  /** First line to return, 1-based. */
  offset: number;
  /** Most lines to return. */
  limit: number;
  /** Most characters of text to collect (the read size cap). */
  maxChars: number;
  /** Byte-faithful: BOM and line endings kept exactly. */
  raw: boolean;
}

export type ReadLinesResult =
  | { binary: true; mimeGuess: string }
  | { binary: false; text: string; startLine: number; endLine: number; totalLines: number | null; truncated: boolean; encoding: TextEncoding };

/** Splits off the complete lines of `buffer` (each with its `\n`), keeping the unfinished rest. */
function takeLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n', start)) {
    lines.push(buffer.slice(start, newline + 1));
    start = newline + 1;
  }
  return { lines, rest: buffer.slice(start) };
}

/**
 * Reads lines `offset`..`offset + limit - 1` of a text file in chunks, never holding more than `maxChars` of text or a
 * chunk of the file. Raw mode returns the bytes' text exactly (BOM and CRLF kept); otherwise the BOM is dropped and
 * CRLF becomes LF. Lines over the line limit are cut with a marker. Binary files are reported, not decoded.
 */
export async function readLines(params: ReadLinesParams): Promise<ReadLinesResult> {
  const { handle, size, offset, limit, maxChars, raw } = params;
  const sample = await handle.read({ offset: 0, length: Math.min(size, BINARY_SAMPLE_BYTES) });
  if (isBinary(sample)) return { binary: true, mimeGuess: mimeGuess(sample) };
  const { encoding } = encodingOf(sample);
  const decoder = decoderFor(encoding);
  const collected: string[] = [];
  let collectedChars = 0;
  let lineNumber = 0;
  let isTruncated = false;
  let pending = '';
  let position = 0;
  let isDone = false;
  /** Takes one complete line; false once nothing more is needed. */
  const take = (line: string): boolean => {
    lineNumber += 1;
    if (lineNumber < offset) return true;
    if (collected.length >= limit || collectedChars >= maxChars) { isTruncated = true; return size <= MAX_COUNTED_BYTES; }
    let text = raw ? line : line.replace(/\r\n$/, '\n');
    if (lineNumber === 1 && !raw) text = text.replace(/^﻿/, '');
    const ending = text.endsWith('\n') ? '\n' : '';
    const { line: kept, isCut } = cutLongLine(ending === '' ? text : text.slice(0, -1));
    if (isCut) isTruncated = true;
    const room = maxChars - collectedChars;
    const piece = kept.length + ending.length > room ? `${kept.slice(0, Math.max(0, room))}… [read cut at the size limit]\n` : kept + ending;
    if (piece !== kept + ending) isTruncated = true;
    collected.push(piece);
    collectedChars += piece.length;
    return true;
  };
  while (!isDone && position < size) {
    const chunk = await handle.read({ offset: position, length: CHUNK_BYTES });
    if (chunk.length === 0) break;
    position += chunk.length;
    const { lines, rest } = takeLines(pending + decoder.decode(chunk, { stream: true }));
    pending = rest;
    for (const line of lines) if (!take(line)) { isDone = true; break; }
  }
  if (!isDone) {
    const last = pending + decoder.decode();
    if (last !== '') take(last);
  }
  const isComplete = !isDone && position >= size;
  const startLine = collected.length === 0 ? Math.min(offset, lineNumber + 1) : offset;
  return { binary: false, text: collected.join(''), startLine, endLine: startLine + collected.length - 1, totalLines: isComplete ? lineNumber : null, truncated: isTruncated, encoding };
}
