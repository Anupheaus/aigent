import { benchError } from './bench-error.js';

/** `npm run bench -- ...` options. */
export interface BenchArgs {
  /** `scripted` (default, deterministic, free) or `model` (a real model from `BENCH_MODEL`; opt-in). */
  tier: 'scripted' | 'model';
  /** Only specs on these repository seeds (default: all). */
  seeds?: number[];
  /** Fresh seeds: the run variants are rebuilt on these seeds (budgets from the reference) and run too. */
  freshSeeds?: number[];
  repeat: number;
  /** Run the held-out specs only (never used while tuning). */
  heldOut: boolean;
  /** Regenerate `bench/tasks/*.json` instead of running. */
  buildSpecs: boolean;
  /** Scripted policies to run (`reference`, `naive`, `decoy`, `lazy`, `optimised`). */
  policies: string[];
  /** Tool set offered (round0, index or optimised; see harness/tool-sets.ts). */
  tools: string;
  /** Results file name (without extension) under `bench/results`; nothing is written without one. */
  label?: string;
  /** Only these catalogue tasks. */
  tasks?: string[];
  /** Check the run against `bench/budgets.json` (the CI gate); a regression makes the run fail. */
  gate: boolean;
  /** Write `bench/budgets.json` from this run (only after a round proved the improvement), named for the round. */
  writeBudgets?: string;
}

const numbers = (value: string, flag: string): number[] => value.split(',').map(part => {
  const parsed = Number(part);
  if (!Number.isInteger(parsed) || parsed < 0) throw benchError(`${flag} expects comma-separated non-negative integers, got '${value}'`, { flag, value });
  return parsed;
});

/** Parses CLI arguments; throws on an unknown flag or a bad value. */
export function parseArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = { tier: 'scripted', repeat: 1, heldOut: false, buildSpecs: false, policies: ['naive', 'reference'], tools: 'round0', gate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    const value = (): string => {
      const next = argv[index + 1];
      if (next == null) throw benchError(`${flag} needs a value`, { flag });
      index += 1;
      return next;
    };
    switch (flag) {
      case '--tier': { const tier = value(); if (tier !== 'scripted' && tier !== 'model') throw benchError(`--tier must be scripted or model, got '${tier}'`, { tier }); args.tier = tier; break; }
      case '--seed': args.seeds = numbers(value(), flag); break;
      case '--fresh-seeds': args.freshSeeds = numbers(value(), flag); break;
      case '--repeat': { const [repeat = 1] = numbers(value(), flag); if (repeat < 1) throw benchError('--repeat must be at least 1', { repeat }); args.repeat = repeat; break; }
      case '--held-out': args.heldOut = true; break;
      case '--build-specs': args.buildSpecs = true; break;
      case '--policies': args.policies = value().split(','); break;
      case '--tools': args.tools = value(); break;
      case '--label': args.label = value(); break;
      case '--tasks': args.tasks = value().split(','); break;
      case '--gate': args.gate = true; break;
      case '--write-budgets': args.writeBudgets = value(); break;
      default: throw benchError(`unknown option '${flag}'`, { flag });
    }
  }
  // The gate judges the whole committed suite: a subset could hide a regression, fresh seeds have no budgets.
  if (args.gate && (args.seeds != null || args.tasks != null || args.freshSeeds != null || args.heldOut)) throw benchError('--gate runs the whole committed suite: drop --seed, --tasks, --fresh-seeds and --held-out', { gate: true });
  return args;
}
