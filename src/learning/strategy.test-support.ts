import { createSeededRandom } from '../core/runtime-services.js';
import { fixtureRun } from '../scoring/fixtures.test-support.js';
import type { RunRecord } from '../telemetry/run-record.js';
import { DEFAULT_STRATEGY_OPTIONS } from './strategy-options.js';
import type { ResolvedStrategyOptions, RunStrategyRecord, StrategyVariant } from './strategy-types.js';

export const AGENT = 'helper';

export function variantFixture(overrides: Partial<StrategyVariant> = {}): StrategyVariant {
  return {
    id: 'variant_1', agentName: AGENT, label: 'batch reads', changes: [{ kind: 'batching-hint', text: 'Read related files in one call.' }], status: 'trial',
    createdAt: 0, createdBy: 'consumer', history: [], trialStartedAt: 0, ...overrides,
  };
}

/** A stored run of the agent with its strategy record; success is a completed run with a claimed success. */
export function strategyRun(params: { index: number; isSuccess: boolean; strategy: RunStrategyRecord; tokens?: number; turns?: number }): RunRecord {
  const { index, isSuccess, strategy, tokens = 1_000, turns = 2 } = params;
  const run = fixtureRun({
    startedAt: index, runId: `run_${index}`, agentName: AGENT, status: isSuccess ? 'completed' : 'failed', claimedSuccess: isSuccess ? 1 : 0, inputTokens: tokens, turns,
  });
  return { ...run, strategy };
}

export interface TrialStream {
  variant: StrategyVariant;
  /** Trial success probability, control success probability. */
  trialRate: number;
  controlRate: number;
  seed: number;
  /** Runs of the stream; each is assigned an arm by the seeded source with probability `trialShare`. */
  runs: number;
  trialShare?: number;
  trialTokens?: number;
}

/** Simulated runs of a trial: Bernoulli outcomes per arm from a seeded source, reproducible by seed. */
export function trialStream(params: TrialStream): RunRecord[] {
  const { variant, trialRate, controlRate, seed, runs, trialShare = 0.5, trialTokens = 1_000 } = params;
  const random = createSeededRandom(seed);
  return Array.from({ length: runs }, (_, index) => {
    const isTrial = random() < trialShare;
    const isSuccess = random() < (isTrial ? trialRate : controlRate);
    return strategyRun({
      index, isSuccess, tokens: isTrial ? trialTokens : 1_000,
      strategy: { bucket: 'short:search', arm: isTrial ? 'trial' : 'control', trialVariantId: variant.id, activeVariantIds: [] },
    });
  });
}

export const OPTIONS: ResolvedStrategyOptions = DEFAULT_STRATEGY_OPTIONS;
