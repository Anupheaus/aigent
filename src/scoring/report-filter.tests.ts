import { describe, expect, it } from 'vitest';
import { fixtureRun } from './fixtures.test-support.js';
import { isVersion, matchesFilter, parseReportFilter } from './report-filter.js';

describe('parseReportFilter', () => {
  it('fills in minRuns and keeps the rest', () => {
    expect(parseReportFilter(undefined)).toEqual({ minRuns: 5 });
    expect(parseReportFilter({ agentName: 'a', minRuns: 3, compareVersions: ['x', 'y'] })).toEqual({ agentName: 'a', minRuns: 3, compareVersions: ['x', 'y'] });
  });

  it.each([
    [{ minRuns: 0 }, 'minRuns'],
    [{ minRuns: 1.5 }, 'minRuns'],
    [{ includeDisabled: true }, 'includeDisabled'],
    [{ compareVersions: ['only-one'] }, 'compareVersions'],
    [{ since: Number.POSITIVE_INFINITY }, 'since'],
    [{ tenant: 't1' }, 'tenant'],
  ])('rejects %j with invalid_input naming %s', (filter, field) => {
    expect(() => parseReportFilter(filter)).toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining(field) }));
  });
});

describe('matchesFilter', () => {
  const run = fixtureRun({ startedAt: 10, agentName: 'a', instanceId: 'i', agentVersion: 'hash', version: 'label', label: 'nightly', unattended: true });

  it('matches when every given field matches, the version by hash or label', () => {
    expect(matchesFilter({ run, filter: {} })).toBe(true);
    expect(matchesFilter({ run, filter: { agentName: 'a', instanceId: 'i', agentVersion: 'label', since: 10, label: 'nightly', unattended: true } })).toBe(true);
    expect(isVersion({ run, version: 'hash' })).toBe(true);
  });

  it.each([[{ agentName: 'b' }], [{ instanceId: 'j' }], [{ agentVersion: 'other' }], [{ since: 11 }], [{ label: 'daily' }], [{ unattended: false }]])('rejects a run not matching %j', filter => {
    expect(matchesFilter({ run, filter })).toBe(false);
  });
});
