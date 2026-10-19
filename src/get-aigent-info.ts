import type { AigentInfo } from './aigent-models.js';

const AIGENT_INFO: AigentInfo = { name: '@anupheaus/aigent', version: '0.0.1' };

/** Placeholder entry point that reserves the public API surface. */
export function getAigentInfo(): AigentInfo {
  return { ...AIGENT_INFO };
}
