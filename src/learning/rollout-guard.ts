import { mean, oneSidedProportionPValue } from '../scoring/stats.js';
import type { RunRecord } from '../telemetry/run-record.js';
import { runSuccess, weightedRate } from './run-success.js';
import type { ResolvedStrategyOptions, StrategyVariant } from './strategy-types.js';

/** One arm of a trial in numbers. */
export interface ArmSummary {
  runs: number;
  /** Weighted success rate (user verdicts count double). */
  rate: number;
  /** Means over successful runs only (never runs a user rated incorrect); null without any. */
  meanTokens: number | null;
  meanTurns: number | null;
}

export interface TrialEvidence {
  trial: ArmSummary;
  control: ArmSummary;
  /** One-sided p-value that the variant is better / worse than the control. */
  pBetter: number;
  pWorse: number;
  /** Buckets where both arms have enough runs and the variant is significantly worse. */
  worseBuckets: string[];
}

export interface TrialVerdict {
  action: 'promote' | 'reject' | 'continue';
  reason: string;
  evidence: TrialEvidence;
}

function byRecordedAt(left: RunRecord, right: RunRecord): number {
  return left.recordedAt - right.recordedAt || (left.runId < right.runId ? -1 : 1);
}

export function summariseArm(runs: RunRecord[]): ArmSummary {
  const scored = runs.flatMap(run => { const success = runSuccess(run); return success == null ? [] : [{ run, success }]; });
  // Efficiency is measured on good answers only, so a run rated incorrect never makes a variant look cheap.
  const succeeded = scored.filter(({ success }) => success.value === 1).map(({ run }) => run);
  return {
    runs: scored.length,
    rate: weightedRate(scored.map(({ success }) => success)).rate,
    meanTokens: mean(succeeded.map(({ usage }) => usage.inputTokens + usage.outputTokens)),
    meanTurns: mean(succeeded.map(({ usage }) => usage.turns)),
  };
}

function pValues(params: { trial: ArmSummary; control: ArmSummary }): { pBetter: number; pWorse: number } {
  const trial = { successes: params.trial.rate * params.trial.runs, n: params.trial.runs };
  const control = { successes: params.control.rate * params.control.runs, n: params.control.runs };
  return { pBetter: oneSidedProportionPValue({ treatment: trial, control }), pWorse: oneSidedProportionPValue({ treatment: control, control: trial }) };
}

function isRegression(params: { trial: number | null; control: number | null; allowed: number }): boolean {
  const { trial, control, allowed } = params;
  return trial != null && control != null && trial > control * (1 + allowed);
}

/** The runs of a trial, split by arm (control runs are those that ran while the variant was in trial). */
export function trialArms(params: { variant: StrategyVariant; runs: RunRecord[] }): { trial: RunRecord[]; control: RunRecord[] } {
  const { variant: { id, agentName }, runs } = params;
  const during = runs.filter(run => run.agentName === agentName && run.strategy?.trialVariantId === id);
  return { trial: during.filter(run => run.strategy?.arm === 'trial'), control: during.filter(run => run.strategy?.arm === 'control') };
}

/**
 * The level each look at a trial is held to. The guard looks again at every run start, and repeated looks inflate the
 * chance of a false promotion, so `alpha` is split over the planned looks (one per `minSamples` trial runs up to
 * `maxTrialRuns`, Bonferroni): the trial as a whole keeps a false-promotion rate below `alpha`.
 */
export function perLookAlpha(options: ResolvedStrategyOptions): number {
  const { alpha, maxTrialRuns, minSamples } = options;
  return alpha / Math.max(1, Math.ceil(maxTrialRuns / minSamples));
}

/**
 * A trial's verdict: promote only with `minSamples` runs per arm, a one-sided p below the per-look level, no bucket
 * where the variant is significantly worse and no efficiency regression above `maxEfficiencyRegression`; reject a
 * variant that is significantly worse, or undecided after `maxTrialRuns`.
 */
export function evaluateTrial(params: { variant: StrategyVariant; runs: RunRecord[]; options: ResolvedStrategyOptions }): TrialVerdict {
  const { variant, runs, options } = params;
  const { minSamples, maxEfficiencyRegression, maxTrialRuns } = options;
  const alpha = perLookAlpha(options);
  const arms = trialArms({ variant, runs });
  const trial = summariseArm(arms.trial);
  const control = summariseArm(arms.control);
  const buckets = [...new Set(arms.trial.map(run => run.strategy?.bucket ?? ''))].sort();
  const worseBuckets = buckets.filter(bucket => {
    const inBucket = (armRuns: RunRecord[]): ArmSummary => summariseArm(armRuns.filter(run => run.strategy?.bucket === bucket));
    const bucketTrial = inBucket(arms.trial);
    const bucketControl = inBucket(arms.control);
    return bucketTrial.runs >= minSamples && bucketControl.runs >= minSamples && pValues({ trial: bucketTrial, control: bucketControl }).pWorse < alpha;
  });
  const evidence: TrialEvidence = { trial, control, ...pValues({ trial, control }), worseBuckets };
  if (trial.runs < minSamples || control.runs < minSamples) return { action: 'continue', reason: `needs ${minSamples} runs per arm (trial ${trial.runs}, control ${control.runs})`, evidence };
  if (evidence.pWorse < alpha) return { action: 'reject', reason: `significantly worse than the control (p = ${evidence.pWorse.toFixed(4)})`, evidence };
  const isLessEfficient = isRegression({ trial: trial.meanTokens, control: control.meanTokens, allowed: maxEfficiencyRegression })
    || isRegression({ trial: trial.meanTurns, control: control.meanTurns, allowed: maxEfficiencyRegression });
  if (evidence.pBetter < alpha && worseBuckets.length === 0 && !isLessEfficient) return { action: 'promote', reason: `significantly better than the control (p = ${evidence.pBetter.toFixed(4)})`, evidence };
  if (trial.runs >= maxTrialRuns) return { action: 'reject', reason: `no significant, efficient improvement after ${trial.runs} trial runs`, evidence };
  return { action: 'continue', reason: isLessEfficient ? 'better but less efficient so far' : 'no significant difference yet', evidence };
}

/** The rollout guard's verdict on an active variant. */
export interface ActiveVerdict {
  action: 'revert' | 'keep';
  reason: string;
  evidence: { recent: ArmSummary; baselineRate: number };
}

/** Reverts an active variant whose last `window` runs fell more than `tolerance` below the rate it was promoted over. */
export function evaluateActive(params: { variant: StrategyVariant; runs: RunRecord[]; options: ResolvedStrategyOptions }): ActiveVerdict {
  const { variant: { id, agentName, promotedAt = 0, baselineRate = 0 }, runs, options: { window, tolerance } } = params;
  const since = runs.filter(run => run.agentName === agentName && run.recordedAt >= promotedAt && run.strategy?.activeVariantIds.includes(id) === true).sort(byRecordedAt);
  const recent = summariseArm(since.slice(-window));
  const evidence = { recent, baselineRate };
  if (recent.runs < window) return { action: 'keep', reason: `${recent.runs} of ${window} runs since promotion`, evidence };
  if (recent.rate < baselineRate - tolerance) return { action: 'revert', reason: `recent success ${recent.rate.toFixed(3)} fell below the baseline ${baselineRate.toFixed(3)} minus ${tolerance}`, evidence };
  return { action: 'keep', reason: 'holding its baseline', evidence };
}
