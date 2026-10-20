import type { RunRecord } from '../telemetry/run-record.js';
import { BASELINE_SIZE, compareRunOrder, rollingBaselines } from './baseline.js';
import { costOfRun } from './pricing.js';
import type { AgentScores, Pricing, Score } from './report-types.js';
import { itemsPerCall, nonRepeatShare, weightedTokens } from './run-metrics.js';
import { reliabilityScore } from './score-reliability.js';
import { formatNumber, formatUsd } from './score-format.js';
import { mean, median, roundToTenth } from './stats.js';

/** Earlier runs of the same agent version a run needs before it is scored. */
export const DEFAULT_MIN_RUNS = 5;
/** A run exactly like its baseline scores 50, so 0 to 100 reads as "worse" to "better than usual". */
const PARITY_SCORE = 50;
/** Twice as good as the baseline (or better) is the top score. */
const MAX_RATIO = 2;
/** Scores at or above this are labelled fast / efficient. */
const GOOD_SCORE = 60;
/** Scores at or below this are labelled slow / inefficient. */
const BAD_SCORE = 40;

export interface ScoreRunsParams {
  /** The runs to score, all of one agent version. */
  runs: RunRecord[];
  /** That version's history (it may include `runs`); each run is compared with the up to 50 runs before it. */
  baseline: RunRecord[];
  minRuns?: number;
  pricing?: Pricing;
}

/** One run compared with its own baseline. */
interface RunComparison {
  score: number;
  runValue: number;
  baselineValue: number;
}

interface MetricSpec {
  /** Wording for evidence, e.g. 'duration'. */
  name: string;
  format(value: number): string;
  goodLabel: Score['label'];
  badLabel: Score['label'];
  /** Why no run could be scored. */
  insufficient(params: { minRuns: number; total: number }): string;
  compare(params: { run: RunRecord; baseline: RunRecord[]; minRuns: number }): RunComparison | undefined;
}

/** How many times better than its baseline a figure is; 0/0 counts as equal, and x/0 as the best possible. */
function ratioOf(numerator: number, denominator: number): number {
  if (denominator <= 0) return numerator <= 0 ? 1 : MAX_RATIO;
  return numerator / denominator;
}

function ratioScore(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(0, ratio)) * PARITY_SCORE;
}

function needsHistory(params: { minRuns: number; total: number }): string {
  const { minRuns, total } = params;
  return `No run had the ${minRuns} earlier runs of this version a score needs (0 of ${total} scored)`;
}

/** A "lower is better" figure (duration, tokens, cost) against the median of the baseline's values. */
function lowerIsBetter(read: (run: RunRecord) => number | null): MetricSpec['compare'] {
  return ({ run, baseline, minRuns }) => {
    const runValue = read(run);
    const baselineValues = baseline.map(read).filter((value): value is number => value != null);
    const baselineValue = median(baselineValues);
    if (runValue == null || baselineValue == null || baselineValues.length < minRuns) return undefined;
    return { score: ratioScore(ratioOf(baselineValue, runValue)), runValue, baselineValue };
  };
}

/** A "higher is better" figure (tool calls per turn, items per call) against the median of the baseline's values. */
function higherIsBetter(read: (run: RunRecord) => number | null): MetricSpec['compare'] {
  return ({ run, baseline, minRuns }) => {
    const runValue = read(run);
    const baselineValues = baseline.map(read).filter((value): value is number => value != null);
    const baselineValue = median(baselineValues);
    if (runValue == null || baselineValue == null || baselineValues.length < minRuns) return undefined;
    return { score: ratioScore(ratioOf(runValue, baselineValue)), runValue, baselineValue };
  };
}

/** Two comparisons averaged; the first one's figures are the ones quoted as evidence. */
function combined(primary: MetricSpec['compare'], secondary: MetricSpec['compare']): MetricSpec['compare'] {
  return input => {
    const first = primary(input);
    const second = secondary(input);
    if (first == null || second == null) return undefined;
    return { ...first, score: (first.score + second.score) / 2 };
  };
}

function metricSpecs(pricing: Pricing | undefined): Record<Exclude<keyof AgentScores, 'reliability'>, MetricSpec> {
  const efficient = { goodLabel: 'efficient', badLabel: 'inefficient', insufficient: needsHistory } as const;
  return {
    speed: { name: 'duration', format: value => `${formatNumber(value)} ms`, goodLabel: 'fast', badLabel: 'slow', insufficient: needsHistory, compare: lowerIsBetter(run => run.timings.durationMs) },
    tokenEfficiency: { ...efficient, name: 'tokens', format: formatNumber, compare: lowerIsBetter(weightedTokens) },
    turnEfficiency: {
      ...efficient, name: 'tool calls per turn', format: formatNumber,
      compare: combined(higherIsBetter(run => run.usage.toolCallsPerTurn), lowerIsBetter(run => run.usage.turns)),
    },
    toolEfficiency: {
      ...efficient, name: 'items per call', format: formatNumber,
      insufficient: ({ minRuns, total }) => `No run had tool calls and ${minRuns} earlier runs of this version with tool calls (0 of ${total} scored)`,
      compare: combined(higherIsBetter(itemsPerCall), higherIsBetter(nonRepeatShare)),
    },
    cost: {
      ...efficient, name: 'cost', format: formatUsd, compare: lowerIsBetter(run => costOfRun({ run, ...(pricing == null ? {} : { pricing }) })),
      insufficient: ({ minRuns, total }) => `No priced run had the ${minRuns} earlier priced runs of this version a score needs (0 of ${total} scored)`,
    },
  };
}

function labelFor(params: { value: number; spec: MetricSpec }): Score['label'] {
  const { value, spec: { goodLabel, badLabel } } = params;
  if (value >= GOOD_SCORE) return goodLabel;
  if (value <= BAD_SCORE) return badLabel;
  return 'average';
}

function scoreMetric(params: { spec: MetricSpec; runs: RunRecord[]; baselines: RunRecord[][]; minRuns: number }): Score {
  const { spec, runs, baselines, minRuns } = params;
  const comparisons = runs.map((run, position) => spec.compare({ run, baseline: baselines[position] ?? [], minRuns })).filter((comparison): comparison is RunComparison => comparison != null);
  const value = mean(comparisons.map(({ score }) => score));
  if (value == null) return { value: null, label: 'insufficient-data', evidence: spec.insufficient({ minRuns, total: runs.length }) };
  const rounded = roundToTenth(value);
  const runMedian = median(comparisons.map(({ runValue }) => runValue)) ?? 0;
  const baselineMedian = median(comparisons.map(({ baselineValue }) => baselineValue)) ?? 0;
  const evidence = `${comparisons.length} of ${runs.length} runs scored against up to ${BASELINE_SIZE} earlier runs of this version; median ${spec.name} ${spec.format(runMedian)} vs baseline median ${spec.format(baselineMedian)}`;
  return { value: rounded, label: labelFor({ value: rounded, spec }), evidence };
}

/** Explains a cost score that cannot exist because the runs' models have no price. */
function unpricedCost(params: { runs: RunRecord[]; pricing?: Pricing }): Score | undefined {
  const { runs, pricing } = params;
  const unpriced = [...new Set(runs.map(({ model }) => model).filter(model => pricing?.[model] == null))].sort();
  if (runs.length === 0 || unpriced.length < new Set(runs.map(({ model }) => model)).size) return undefined;
  return { value: null, label: 'insufficient-data', evidence: `No pricing for ${unpriced.map(model => `'${model}'`).join(', ')}; pass createAigent({ pricing }) to score cost` };
}

/**
 * Scores runs of one agent version against that version's own rolling baseline: each run is compared with the median
 * of the up to 50 runs before it (runs with fewer than `minRuns` earlier runs are not scored), and the per-run scores
 * are averaged. Pure and deterministic: input order never matters.
 */
export function scoreRuns(params: ScoreRunsParams): AgentScores {
  const { baseline, minRuns = DEFAULT_MIN_RUNS, pricing } = params;
  const runs = [...params.runs].sort(compareRunOrder);
  const baselines = rollingBaselines({ runs, pool: baseline });
  const specs = metricSpecs(pricing);
  const score = (spec: MetricSpec): Score => scoreMetric({ spec, runs, baselines, minRuns });
  return {
    speed: score(specs.speed),
    tokenEfficiency: score(specs.tokenEfficiency),
    turnEfficiency: score(specs.turnEfficiency),
    toolEfficiency: score(specs.toolEfficiency),
    cost: unpricedCost({ runs, ...(pricing == null ? {} : { pricing }) }) ?? score(specs.cost),
    reliability: reliabilityScore({ runs, baselines, minRuns }),
  };
}
