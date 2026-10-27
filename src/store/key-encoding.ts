import { createHash } from 'node:crypto';

/** Longest file or directory name produced; longer encodings are cut and given a hash of the whole name. */
const MAX_ENCODED_LENGTH = 120;
/** Marks a shortened name; `~` is always escaped in ordinary encodings, so a marked name never collides with one. */
const SHORTENED_MARK = '~';
const HASH_LENGTH = 16;
/** The empty string has no bytes to encode; `%` is never followed by a non-hex pair elsewhere, so this is unique. */
const EMPTY_NAME = '%empty';
const HEX_RADIX = 16;
const SAFE_CHARACTER = /[a-z0-9_-]/;
/** Device names Windows refuses as file names whatever their extension (compared in lower case). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

function escapeByte(byte: number): string {
  return `%${byte.toString(HEX_RADIX).padStart(2, '0')}`;
}

/**
 * Encodes any string as a name that is safe on Windows, macOS and Linux: only lower-case letters, digits, `_`, `-`
 * and `%xx` escapes of the UTF-8 bytes. Upper-case letters and `.` are escaped too, so names that differ only in
 * case stay distinct on case-insensitive disks and `.`/`..`/trailing dots cannot occur. Distinct inputs give
 * distinct outputs; the decoded key is also kept inside the record, so listing never needs to reverse this.
 */
export function encodeName(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  let encoded = '';
  for (const byte of bytes) {
    const character = String.fromCharCode(byte);
    encoded += byte < 0x80 && SAFE_CHARACTER.test(character) ? character : escapeByte(byte);
  }
  if (encoded === '') return EMPTY_NAME;
  if (WINDOWS_RESERVED.test(encoded)) encoded = escapeByte(encoded.charCodeAt(0)) + encoded.slice(1);
  if (encoded.length <= MAX_ENCODED_LENGTH) return encoded;
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, HASH_LENGTH);
  return `${encoded.slice(0, MAX_ENCODED_LENGTH - HASH_LENGTH - 1)}${SHORTENED_MARK}${hash}`;
}
