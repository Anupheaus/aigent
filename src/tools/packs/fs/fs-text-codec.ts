import { toolFailure } from '../../tool-failure.js';
import { BINARY_SAMPLE_BYTES, encodingOf, isBinary } from './fs-text.js';
import type { TextEncoding } from './fs-text.js';

const BOM = '﻿';

/** Text as `fs_read` shows it (every CRLF as LF, lone CRs kept), with where the CRLFs were, so they can be put back. */
export interface EditableText {
  text: string;
  /** Indices in `text` of the `\n`s that were `\r\n` on disk, ascending. */
  crlf: number[];
}

/** A file decoded exactly: writing `encodeText` of the same text in the same encoding gives back the same bytes. */
export interface DecodedText {
  encoding: TextEncoding;
  hasBom: boolean;
  doc: EditableText;
  /** Most line breaks are CRLF, so new line breaks written into the file are CRLF too. */
  usesCrlf: boolean;
}

/** The bytes of `text` (a BOM is written only when `text` starts with one) in `encoding`. */
export function encodeText(params: { text: string; encoding: TextEncoding }): Uint8Array {
  const { text, encoding } = params;
  if (encoding === 'utf-16le') return new Uint8Array(Buffer.from(text, 'utf16le'));
  if (encoding === 'utf-16be') return new Uint8Array(Buffer.from(text, 'utf16le').swap16());
  return new TextEncoder().encode(text);
}

/** CRLF to LF with their positions recorded; a lone CR stays as it is. */
export function toEditable(raw: string): EditableText {
  const crlf: number[] = [];
  let text = '';
  let from = 0;
  for (let at = raw.indexOf('\r\n'); at !== -1; at = raw.indexOf('\r\n', from)) {
    text += raw.slice(from, at);
    crlf.push(text.length);
    text += '\n';
    from = at + 2;
  }
  return { text: text + raw.slice(from), crlf };
}

/** Puts back the CRLFs `toEditable` recorded (and any the edits added). */
export function fromEditable(doc: EditableText): string {
  const { text, crlf } = doc;
  let raw = '';
  let from = 0;
  for (const at of crlf) {
    raw += `${text.slice(from, at)}\r\n`;
    from = at + 1;
  }
  return raw + text.slice(from);
}

function refused(params: { code: string; message: string; suggestion: string }): never {
  throw toolFailure({ retryable: false, ...params });
}

/**
 * Decodes a whole text file for editing, failing closed: a binary file (`binary_file`), bytes invalid in the file's
 * encoding anywhere in it (`invalid_encoding`), or any encoding that would not write back byte for byte
 * (`unsupported_encoding`) is refused rather than silently corrupted.
 */
export function decodeExactly(params: { bytes: Uint8Array; path: string }): DecodedText {
  const { bytes, path } = params;
  const { encoding } = encodingOf(bytes);
  if (isBinary(bytes.subarray(0, BINARY_SAMPLE_BYTES))) refused({ code: 'binary_file', message: `'${path}' is a binary file; fs_edit only edits text`, suggestion: 'Use fs_write to replace it whole, if that is really intended' });
  let decoded: string;
  try {
    decoded = new TextDecoder(encoding === 'utf-8-bom' ? 'utf-8' : encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // Invalid bytes anywhere (not only in the sample): editing would replace them with U+FFFD.
    return refused({ code: 'invalid_encoding', message: `'${path}' is not valid ${encoding} text throughout, so editing it could corrupt the bytes that are not`, suggestion: 'Leave the file alone, or replace it whole with fs_write if that is really intended' });
  }
  if (Buffer.compare(Buffer.from(encodeText({ text: decoded, encoding })), Buffer.from(bytes)) !== 0) {
    refused({ code: 'unsupported_encoding', message: `'${path}' would not be written back byte for byte in ${encoding}, so it is not edited`, suggestion: 'Replace it whole with fs_write if that is really intended' });
  }
  const hasBom = decoded.startsWith(BOM);
  const doc = toEditable(hasBom ? decoded.slice(1) : decoded);
  const lineBreaks = (doc.text.match(/\n/g) ?? []).length;
  return { encoding, hasBom, doc, usesCrlf: doc.crlf.length > lineBreaks - doc.crlf.length };
}

/** The file's bytes for an edited document, in its own encoding, with its BOM and recorded CRLFs. */
export function encodeEdited(params: { decoded: Pick<DecodedText, 'encoding' | 'hasBom'>; doc: EditableText }): Uint8Array {
  const { decoded: { encoding, hasBom }, doc } = params;
  return encodeText({ text: (hasBom ? BOM : '') + fromEditable(doc), encoding });
}
