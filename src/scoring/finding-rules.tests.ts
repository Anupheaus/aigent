import { describe, expect, it } from 'vitest';
import { compareFindings, groupSorted, makeFinding } from './finding-rules.js';
import type { Finding } from './report-types.js';
import { formatNumber, formatUsd } from './score-format.js';
import { fixtureSteps } from './fixtures.test-support.js';
import { isWorkStep, topLevelWorkSteps } from './work-steps.js';

function finding(params: Pick<Finding, 'kind' | 'severity' | 'subject'>): Finding {
  return makeFinding({ ...params, label: 'inefficient', agentName: 'a', message: 'm', evidence: {} });
}

describe('finding helpers', () => {
  it('builds stable ids and orders by severity, then id', () => {
    const findings = [
      finding({ kind: 'slow-run', severity: 'warn', subject: 'r2' }),
      finding({ kind: 'truncation-frequent', severity: 'info', subject: 'big' }),
      finding({ kind: 'failing-tool', severity: 'bad', subject: 'fetch' }),
      finding({ kind: 'slow-run', severity: 'warn', subject: 'r1' }),
    ];
    expect(findings.sort(compareFindings).map(({ id }) => id)).toEqual(['failing-tool:a:fetch', 'slow-run:a:r1', 'slow-run:a:r2', 'truncation-frequent:a:big']);
  });

  it('groups by key with keys sorted', () => {
    expect(groupSorted({ items: ['b1', 'a1', 'b2'], keyOf: value => value.charAt(0) })).toEqual([['a', ['a1']], ['b', ['b1', 'b2']]]);
  });

  it('leaves wrappers, commentary and inner calls out of top-level work', () => {
    const steps = fixtureSteps([{ tool: 'aigent_multi' }, { tool: 'read', parentCallId: 'c0' }, { tool: 'aigent_feedback' }, { tool: 'search' }]);
    expect(steps.filter(isWorkStep).map(({ tool }) => tool)).toEqual(['read', 'search']);
    expect(topLevelWorkSteps(steps).map(({ tool }) => tool)).toEqual(['search']);
  });

  it('formats evidence figures', () => {
    expect(formatNumber(1_234.56)).toBe('1,234.6');
    expect(formatUsd(0.0012345)).toBe('$0.001235');
  });
});
