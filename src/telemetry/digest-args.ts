import { createHmac } from 'node:crypto';
import { canonicalJson } from '../core/canonical-json.js';

/** Hex characters kept from the digest: 128 bits, ample to tell one run's calls apart. */
const ARGS_DIGEST_LENGTH = 32;

export interface DigestArgsParams {
  args: unknown;
  /** Salts the digest (the run id), so equal arguments only match within one run and cannot be looked up across runs. */
  key: string;
}

/**
 * A content-free fingerprint of a call's full arguments (HMAC-SHA-256 of their canonical JSON), so repeats can be found
 * even when content capture is off or the argument summary is cut short. The arguments cannot be read back from it.
 */
export function digestArgs(params: DigestArgsParams): string {
  const { args, key } = params;
  return createHmac('sha256', key).update(canonicalJson(args) ?? '').digest('hex').slice(0, ARGS_DIGEST_LENGTH);
}
