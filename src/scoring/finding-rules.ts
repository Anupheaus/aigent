import type { Finding, FindingKind, FindingSeverity } from './report-types.js';

/** A tool needs at least this many calls (across the agent's runs) before it is judged. */
export const MIN_TOOL_CALLS = 3;

export interface MakeFindingParams {
  kind: FindingKind;
  severity: FindingSeverity;
  label: Finding['label'];
  agentName: string;
  subject: string;
  message: string;
  evidence: Record<string, unknown>;
}

/** A finding with its stable id. */
export function makeFinding(params: MakeFindingParams): Finding {
  const { kind, agentName, subject } = params;
  return { id: `${kind}:${agentName}:${subject}`, ...params };
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { bad: 0, warn: 1, info: 2 };

/** Most severe first, then by id, so the order never depends on how the records were read. */
export function compareFindings(left: Finding, right: Finding): number {
  const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (bySeverity !== 0) return bySeverity;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Groups items by a key, keys sorted, so callers iterate in a fixed order. */
export function groupSorted<T>(params: { items: T[]; keyOf(item: T): string }): [string, T[]][] {
  const { items, keyOf } = params;
  const groups = new Map<string, T[]>();
  for (const entry of items) {
    const key = keyOf(entry);
    groups.set(key, [...groups.get(key) ?? [], entry]);
  }
  return [...groups.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}
