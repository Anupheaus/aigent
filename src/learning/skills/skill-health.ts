import type { RunTrace } from '../../telemetry/run-record.js';
import { runSuccess, weightedRate } from '../run-success.js';
import type { Skill } from './skill-types.js';

/** `createAigent({ learning: { skills } })`: when an active skill is retired automatically. */
export interface SkillOptions {
  /** Success rate below which an active skill is retired (default 0.5). */
  retireBelow?: number;
  /** Most recent runs that used the skill, looked at (default 20); fewer never retire it. */
  retireWindow?: number;
}

const DEFAULT_RETIRE_BELOW = 0.5;
const DEFAULT_RETIRE_WINDOW = 20;

/** How an active skill is doing since it became active. */
export interface SkillHealth {
  uses: number;
  successRate: number;
  /** Why it should be retired; undefined while it holds up. */
  retire?: string;
}

/**
 * The runs that called the skill since its current version became active, scored like every learning statistic (user
 * verdicts first). The skill is retired once its last `retireWindow` uses fall below `retireBelow`.
 */
export function evaluateSkillUse(params: { skill: Skill; traces: RunTrace[]; options?: SkillOptions }): SkillHealth {
  const { skill: { name, version, history }, traces, options = {} } = params;
  const { retireBelow = DEFAULT_RETIRE_BELOW, retireWindow = DEFAULT_RETIRE_WINDOW } = options;
  const activatedAt = Math.max(0, ...history.filter(event => event.status === 'active' && event.version === version).map(({ at }) => at));
  const uses = traces
    .filter(({ run, steps }) => run.recordedAt >= activatedAt && steps.some(step => step.tool === name && step.parentCallId == null))
    .sort((left, right) => left.run.recordedAt - right.run.recordedAt);
  const recent = uses.slice(-retireWindow).flatMap(({ run }) => { const success = runSuccess(run); return success == null ? [] : [success]; });
  const { rate } = weightedRate(recent);
  const health = { uses: uses.length, successRate: rate };
  if (recent.length < retireWindow || rate >= retireBelow) return health;
  return { ...health, retire: `its last ${recent.length} uses succeeded at ${rate.toFixed(3)}, below ${retireBelow}` };
}
