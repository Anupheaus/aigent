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
/** A surrogate code unit not paired with its partner (`u` mode reads a valid pair as one astral code point). */
const LONE_SURROGATE = /\p{Cs}/u;
/** Escapes a lone surrogate, which UTF-8 cannot hold, as `%u` plus its four hex digits; `u` is never a hex digit. */
const SURROGATE_MARK = '%u';
const SURROGATE_HEX_DIGITS = 4;
/** Device names Windows refuses as file names whatever their extension (compared in lower case). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

function escapeByte(byte: number): string {
  return `%${byte.toString(HEX_RADIX).padStart(2, '0')}`;
}

/**
 * Encodes any string as a name that is safe on Windows, macOS and Linux: only lower-case letters, digits, `_`, `-`
 * and `%xx` escapes of the UTF-8 bytes (a lone surrogate, which has none, is `%u` and its four hex digits). Upper-case letters and `.` are escaped too, so names that differ only in
 * case stay distinct on case-insensitive disks and `.`/`..`/trailing dots cannot occur. Distinct inputs give
 * distinct outputs; the decoded key is also kept inside the record, so listing never needs to reverse this.
 */
export function encodeName(name: string): string {
  let encoded = '';
  // `for...of` walks code points, yielding a lone surrogate on its own.
  for (const codePoint of name) {
    if (LONE_SURROGATE.test(codePoint)) {
      encoded += `${SURROGATE_MARK}${codePoint.charCodeAt(0).toString(HEX_RADIX).padStart(SURROGATE_HEX_DIGITS, '0')}`;
      continue;
    }
    for (const byte of Buffer.from(codePoint, 'utf8')) {
      const character = String.fromCharCode(byte);
      encoded += byte < 0x80 && SAFE_CHARACTER.test(character) ? character : escapeByte(byte);
    }
  }
  if (encoded === '') return EMPTY_NAME;
  if (WINDOWS_RESERVED.test(encoded)) encoded = escapeByte(encoded.charCodeAt(0)) + encoded.slice(1);
  if (encoded.length <= MAX_ENCODED_LENGTH) return encoded;
  // UTF-8 bytes would turn a lone surrogate into U+FFFD; the full encoding never collides, so it is hashed instead.
  const hashed = LONE_SURROGATE.test(name) ? encoded : Buffer.from(name, 'utf8');
  const hash = createHash('sha256').update(hashed).digest('hex').slice(0, HASH_LENGTH);
  return `${encoded.slice(0, MAX_ENCODED_LENGTH - HASH_LENGTH - 1)}${SHORTENED_MARK}${hash}`;
}
