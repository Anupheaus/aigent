import { createHash } from 'node:crypto';

/** How a text file is encoded on disk. */
export type TextEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be';

/** How much of a file's start is inspected to tell text from binary. */
export const BINARY_SAMPLE_BYTES = 8_192;
/** Lines longer than this are cut with an explicit marker, so one minified line cannot flood the context. */
export const MAX_LINE_CHARS = 20_000;

const UTF8_BOM = [0xef, 0xbb, 0xbf];

export function encodingOf(bytes: Uint8Array): { encoding: TextEncoding; bomLength: number } {
  if (UTF8_BOM.every((byte, index) => bytes[index] === byte)) return { encoding: 'utf-8-bom', bomLength: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', bomLength: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', bomLength: 2 };
  return { encoding: 'utf-8', bomLength: 0 };
}

/** NUL bytes or invalid UTF-8 in the sample (a UTF-16 file with its BOM is text). */
export function isBinary(sample: Uint8Array): boolean {
  const { encoding } = encodingOf(sample);
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return false;
  if (sample.includes(0)) return true;
  try {
    // `stream: true` lets a multi-byte character cut by the sample's end pass.
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
    return false;
  } catch {
    // Not valid UTF-8: treated as binary rather than shown as replacement characters.
    return true;
  }
}

/** A streaming decoder for the encoding; the BOM is kept in the text (the caller decides whether to show it). */
export function decoderFor(encoding: TextEncoding): TextDecoder {
  const label = encoding === 'utf-8-bom' ? 'utf-8' : encoding;
  return new TextDecoder(label, { ignoreBOM: true });
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Cuts a line over `MAX_LINE_CHARS` with a marker saying how much was left out. */
export function cutLongLine(line: string): { line: string; isCut: boolean } {
  if (line.length <= MAX_LINE_CHARS) return { line, isCut: false };
  return { line: `${line.slice(0, MAX_LINE_CHARS)}… [line cut: ${line.length - MAX_LINE_CHARS} more characters]`, isCut: true };
}

const MAGIC: readonly { bytes: number[]; mime: string }[] = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], mime: 'application/zip' },
  { bytes: [0x1f, 0x8b], mime: 'application/gzip' },
  { bytes: [0x00, 0x61, 0x73, 0x6d], mime: 'application/wasm' },
  { bytes: [0x4d, 0x5a], mime: 'application/vnd.microsoft.portable-executable' },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], mime: 'application/x-elf' },
];

/** A best guess at a binary file's type from its first bytes. */
export function mimeGuess(sample: Uint8Array): string {
  return MAGIC.find(({ bytes }) => bytes.every((byte, index) => sample[index] === byte))?.mime ?? 'application/octet-stream';
}
