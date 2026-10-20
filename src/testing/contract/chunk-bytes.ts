import { createAigentError } from '../../core/aigent-error.js';

const encoder = new TextEncoder();

/**
 * Encodes `text` as UTF-8 and splits it into network chunks of `size` bytes, cutting lines, JSON and multi-byte
 * characters mid-way. Contract subjects should deliver fixture bodies this way (a size of a few bytes) so their
 * provider's parsing is tested against real network chunking.
 */
export function chunkBytes(text: string, size: number): Uint8Array[] {
  if (!Number.isInteger(size) || size < 1) {
    throw createAigentError({ code: 'invalid_input', message: `chunkBytes size must be a positive integer; got ${size}` });
  }
  const bytes = encoder.encode(text);
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) chunks.push(bytes.slice(start, start + size));
  return chunks;
}
