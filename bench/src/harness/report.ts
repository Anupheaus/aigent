import type { RunRow } from './run-task.js';
import type { SuiteRun } from './suite.js';

/** Headline numbers of one solver over a suite (efficiency counts only correct runs). */
export interface Aggregate {
  solver: string;
  runs: number;
  correctRate: number;
  passRate: number;
  targetRate: number;
  stretchRate: number;
  medianTokens: number;
  p90Tokens: number;
  medianTurns: number;
  p90Turns: number;
  medianToolCalls: number;
  /** Cost needs a priced model; the scripted tier has none. */
  costUsd: null;
}

/** Median and inter-quartile range of a metric, over repetitions and seeds of one task family. */
export interface Spread {
  median: number;
  iqr: number;
}

export interface FamilyVariance {
  family: string;
  solver: string;
  tokens: Spread;
  turns: Spread;
  ms: Spread;
}

export interface SuiteReport {
  /** Free-form name of the run (`round-0`...). */
  label: string;
  tier: 'scripted' | 'model';
  repeat: number;
  specs: number;
  aggregates: Aggregate[];
  variance: FamilyVariance[];
  rows: RunRow[];
}

/** The `fraction` quantile (nearest rank) of values; 0 for none. */
export function quantile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? 0;
}

const spread = (values: number[]): Spread => ({ median: quantile(values, 0.5), iqr: quantile(values, 0.75) - quantile(values, 0.25) });
const rate = (rows: RunRow[], test: (row: RunRow) => boolean): number => (rows.length === 0 ? 0 : rows.filter(test).length / rows.length);

export function aggregate(rows: RunRow[]): Aggregate[] {
  const solvers = [...new Set(rows.map(({ solver }) => solver))];
  return solvers.map(solver => {
    const mine = rows.filter(row => row.solver === solver);
    const correct = mine.filter(({ correct: isCorrect }) => isCorrect);
    return {
      solver, runs: mine.length, correctRate: rate(mine, row => row.correct),
      passRate: rate(mine, ({ tier }) => tier === 'pass' || tier === 'target' || tier === 'stretch'),
      targetRate: rate(mine, ({ tier }) => tier === 'target' || tier === 'stretch'),
      stretchRate: rate(mine, ({ tier }) => tier === 'stretch'),
      medianTokens: quantile(correct.map(({ tokens }) => tokens), 0.5), p90Tokens: quantile(correct.map(({ tokens }) => tokens), 0.9),
      medianTurns: quantile(correct.map(({ turns }) => turns), 0.5), p90Turns: quantile(correct.map(({ turns }) => turns), 0.9),
      medianToolCalls: quantile(correct.map(({ toolCalls }) => toolCalls), 0.5),
      costUsd: null,
    };
  });
}

/** Per task family and solver: spread of tokens, turns and time over every repetition, variant and seed. */
export function variance(rows: RunRow[]): FamilyVariance[] {
  const keys = [...new Set(rows.map(({ family, solver }) => `${family}\u0000${solver}`))].sort();
  return keys.map(key => {
    const [family = '', solver = ''] = key.split('\u0000');
    const mine = rows.filter(row => row.family === family && row.solver === solver);
    return { family, solver, tokens: spread(mine.map(({ tokens }) => tokens)), turns: spread(mine.map(({ turns }) => turns)), ms: spread(mine.map(({ ms }) => ms)) };
  });
}

export function buildReport(params: { label: string; tier: SuiteReport['tier']; runs: SuiteRun[]; specs: number }): SuiteReport {
  const { label, tier, runs, specs } = params;
  const rows = runs.flatMap(run => run.rows);
  return { label, tier, repeat: runs.length, specs, aggregates: aggregate(rows), variance: variance(rows), rows };
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

/** A markdown summary: the headline table, then per-family medians and spreads. */
export function reportMarkdown(report: SuiteReport): string {
  const head = ['| solver | runs | correct | pass | target | stretch | median tokens | p90 tokens | median turns | p90 turns | median calls |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  const lines = report.aggregates.map(({ solver, runs, correctRate, passRate, targetRate, stretchRate, medianTokens, p90Tokens, medianTurns, p90Turns, medianToolCalls }) =>
    `| ${solver} | ${runs} | ${percent(correctRate)} | ${percent(passRate)} | ${percent(targetRate)} | ${percent(stretchRate)} | ${medianTokens} | ${p90Tokens} | ${medianTurns} | ${p90Turns} | ${medianToolCalls} |`);
  const families = ['| family | solver | tokens median (IQR) | turns median (IQR) | ms median (IQR) |', '|---|---|---|---|---|', ...report.variance.map(({ family, solver, tokens, turns, ms }) => `| ${family} | ${solver} | ${tokens.median} (${tokens.iqr}) | ${turns.median} (${turns.iqr}) | ${ms.median} (${ms.iqr}) |`)];
  return [`# ${report.label}`, '', `Tier: ${report.tier}. Specs: ${report.specs}. Repetitions: ${report.repeat}.`, '', ...head, ...lines, '', '## Per task family', '', ...families, ''].join('\n');
}
