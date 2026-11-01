import { createHash } from 'node:crypto';
import { canonicalJson } from '../core/canonical-json.js';

/** One scalar value inside a tool result, at its JSON pointer (RFC 6901, `''` for a scalar result). */
export interface ResultLeaf {
  path: string;
  value: string | number | boolean;
}

/** Leaves kept per result, the depth walked and the longest string kept: enough to bind later arguments, not a copy. */
export const MAX_RESULT_LEAVES = 64;
const MAX_LEAF_DEPTH = 6;
export const MAX_LEAF_STRING_LENGTH = 300;

function escapeSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function unescapeSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function isScalar(value: unknown): value is ResultLeaf['value'] {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * The result's scalar leaves in a fixed order (object keys sorted, arrays in order), at most `MAX_RESULT_LEAVES`, down
 * to `MAX_LEAF_DEPTH`; strings longer than `MAX_LEAF_STRING_LENGTH` are left out (file bodies are not identifiers).
 */
export function resultLeaves(result: unknown): ResultLeaf[] {
  const leaves: ResultLeaf[] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (leaves.length >= MAX_RESULT_LEAVES) return;
    if (isScalar(value)) {
      if (typeof value !== 'string' || value.length <= MAX_LEAF_STRING_LENGTH) leaves.push({ path, value });
      return;
    }
    if (depth >= MAX_LEAF_DEPTH || value === null || typeof value !== 'object') return;
    const entries: [string, unknown][] = Array.isArray(value) ? value.map((item, position) => [String(position), item]) : Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1));
    for (const [segment, child] of entries) walk(child, `${path}/${escapeSegment(segment)}`, depth + 1);
  };
  walk(result, '', 0);
  return leaves;
}

/** The value at a JSON pointer, or undefined when the path does not exist. Reads only: nothing in the path is evaluated. */
export function readPointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  let current: unknown = value;
  for (const segment of path.slice(1).split('/').map(unescapeSegment)) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** sha-256 of the result's canonical JSON. */
export function resultHash(result: unknown): string {
  return createHash('sha256').update(canonicalJson(result ?? null)).digest('hex');
}
