import { describe, expect, it } from 'vitest';
import { createSeededRandom } from '../../core/runtime-services.js';
import { fixtureTrace } from '../../scoring/fixtures.test-support.js';
import type { RunTrace } from '../../telemetry/run-record.js';
import { evaluateSkillUse } from './skill-health.js';
import type { Skill } from './skill-types.js';

const ACTIVATED_AT = 10_000;
const skill = {
  name: 'skill_search_then_read', version: 2,
  history: [{ at: 1, version: 1, status: 'active' }, { at: ACTIVATED_AT, version: 2, status: 'active' }],
} as unknown as Skill;

/** Runs that called the skill, each a success with probability `rate` (seeded), recorded after `from`. */
function uses(params: { count: number; rate: number; seed: number; from: number }): RunTrace[] {
  const { count, rate, seed, from } = params;
  const random = createSeededRandom(seed);
  return Array.from({ length: count }, (_, index) => {
    const isSuccess = random() < rate;
    return fixtureTrace({
      run: { startedAt: from + index, runId: `use_${from + index}`, status: isSuccess ? 'completed' : 'failed', claimedSuccess: isSuccess ? 1 : 0 },
      steps: [{ tool: 'skill_search_then_read' }],
    });
  });
}

describe('evaluateSkillUse (auto-retire)', () => {
  it('retires a skill whose recent uses degrade, and keeps a healthy one (simulated streams)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(evaluateSkillUse({ skill, traces: uses({ count: 40, rate: 0.2, seed, from: ACTIVATED_AT }) }).retire).toEqual(expect.stringContaining('below 0.5'));
      expect(evaluateSkillUse({ skill, traces: uses({ count: 40, rate: 0.9, seed, from: ACTIVATED_AT }) }).retire).toBeUndefined();
    }
  });

  it('never retires on fewer uses than the window, however they went', () => {
    expect(evaluateSkillUse({ skill, traces: uses({ count: 19, rate: 0, seed: 1, from: ACTIVATED_AT }) })).toEqual({ uses: 19, successRate: 0 });
  });

  it('counts only uses since the current version became active, and only top-level calls', () => {
    const before = uses({ count: 30, rate: 0, seed: 1, from: 0 });
    const inner = uses({ count: 30, rate: 0, seed: 1, from: ACTIVATED_AT }).map(trace => ({ ...trace, steps: trace.steps.map(step => ({ ...step, parentCallId: 'c' })) }));
    expect(evaluateSkillUse({ skill, traces: [...before, ...inner] })).toEqual({ uses: 0, successRate: 0 });
  });

  it('lets user verdicts outrank the agent claims', () => {
    const rated = uses({ count: 30, rate: 1, seed: 1, from: ACTIVATED_AT }).map(trace => ({ ...trace, run: { ...trace.run, userVerdict: 'incorrect' as const } }));
    expect(evaluateSkillUse({ skill, traces: rated }).retire).toBeDefined();
  });
});
