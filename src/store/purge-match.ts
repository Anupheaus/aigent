import type { PurgeFilter } from './store-types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every given criterion must hold; a record without the field a criterion needs never matches it. */
export function matchesPurge(value: unknown, filter: PurgeFilter): boolean {
  const { agentName, runId, before } = filter;
  if (!isPlainObject(value)) return false;
  if (agentName != null && value.agentName !== agentName) return false;
  if (runId != null && value.runId !== runId) return false;
  if (before != null && !(typeof value.recordedAt === 'number' && value.recordedAt < before)) return false;
  return true;
}
