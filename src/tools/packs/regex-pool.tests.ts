import { describe, expect, it } from 'vitest';
import { MAX_REGEX_WORKERS, regexWorkerCount, runRegexJob } from './regex-pool.js';

/** The patterns the review found slipping past the old heuristic, each with an input that makes it backtrack for ages. */
const CATASTROPHIC: [string, string, string][] = [
  ['((a+))+$', '', `${'a'.repeat(40)}!`],
  ['(?:(a+))+$', '', `${'a'.repeat(40)}!`],
  ['(?<x>a|aa)+$', '', `${'a'.repeat(60)}!`],
  ['(a|A)+$', 'i', `${'a'.repeat(40)}!`],
  ['(a|aa){30}$', '', `${'a'.repeat(45)}!`],
  ['\\w*\\w*\\w*\\w*\\w*\\w*!', '', 'a'.repeat(400)],
];
const JOB_TIMEOUT_MS = 300;
/** Ticks of a 10 ms interval must keep arriving: a blocked main thread would leave a gap of seconds (the slack is for a loaded test host). */
const MAX_TICK_GAP_MS = 500;

/** Runs `work` while measuring the longest gap between 10 ms interval ticks on this thread. */
async function longestTickGap(work: () => Promise<void>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const interval = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 10);
  try {
    await work();
  } finally {
    clearInterval(interval);
  }
  return longest;
}

describe('runRegexJob (worker threads with a hard deadline)', () => {
  it('matches in a worker and returns captures, groups and counts', async () => {
    const outcome = await runRegexJob({ job: { pattern: 'id=(?<n>\\d+)', flags: 'g', texts: ['id=1 id=22', 'none', 'id=3'], keep: 2, countAll: true }, deadline: Date.now() + 5_000 });
    expect(outcome).toEqual({ status: 'done', count: 3, isComplete: true, matches: [
      { text: 0, index: 0, match: 'id=1', captures: ['1'], groups: { n: '1' } },
      { text: 0, index: 5, match: 'id=22', captures: ['22'], groups: { n: '22' } },
    ] });
    const stopped = await runRegexJob({ job: { pattern: 'x', flags: 'g', texts: ['xxxx'], keep: 2, countAll: false }, deadline: Date.now() + 5_000 });
    expect(stopped).toMatchObject({ status: 'done', count: 2, isComplete: false });
  });

  it.each(CATASTROPHIC)('stops %s (flags %s) at the deadline while this thread stays responsive', async (pattern, flags, text) => {
    let outcome: Awaited<ReturnType<typeof runRegexJob>> | undefined;
    const started = performance.now();
    const gap = await longestTickGap(async () => {
      outcome = await runRegexJob({ job: { pattern, flags: `${flags}g`, texts: [text], keep: 10, countAll: true }, deadline: Date.now() + JOB_TIMEOUT_MS });
    });
    expect(outcome).toEqual({ status: 'timed-out' });
    expect(performance.now() - started).toBeLessThan(JOB_TIMEOUT_MS + 2_000);
    expect(gap).toBeLessThan(MAX_TICK_GAP_MS);
  });

  it('never runs more than the pool size at once, and every job still ends', async () => {
    let peak = 0;
    const watch = setInterval(() => { peak = Math.max(peak, regexWorkerCount()); }, 5);
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => runRegexJob({ job: { pattern: '((a+))+$', flags: 'g', texts: [`${'a'.repeat(40)}!`], keep: 1, countAll: true }, deadline: Date.now() + JOB_TIMEOUT_MS })));
    clearInterval(watch);
    expect(outcomes.every(({ status }) => status === 'timed-out')).toBe(true);
    expect(peak).toBeLessThanOrEqual(MAX_REGEX_WORKERS);
    expect(regexWorkerCount()).toBeLessThanOrEqual(MAX_REGEX_WORKERS);
  });

  it('terminates the worker when the signal aborts, and reports a pattern error', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const aborted = await runRegexJob({ job: { pattern: '((a+))+$', flags: 'g', texts: [`${'a'.repeat(40)}!`], keep: 1, countAll: true }, deadline: Date.now() + 10_000, signal: controller.signal });
    expect(aborted).toEqual({ status: 'aborted' });
    expect(await runRegexJob({ job: { pattern: '(', flags: 'g', texts: ['x'], keep: 1, countAll: true }, deadline: Date.now() + 5_000 })).toMatchObject({ status: 'failed' });
  });
});
