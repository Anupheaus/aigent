import { fixtureTrace } from '../scoring/fixtures.test-support.js';
import type { FixtureRunParams } from '../scoring/fixtures.test-support.js';
import type { RunTrace } from '../telemetry/run-record.js';

export const FIND_FILE_TASK = 'Find the file that defines ThemeProvider';
const STEP_GAP_MS = 1_000;
const STEP_DURATION_MS = 200;

type RunOverrides = Omit<FixtureRunParams, 'startedAt'>;

/** search -> read (fails) -> search -> read (found): the agent flailing to locate a file, over four turns. */
export function flailingRun(startedAt: number, overrides: RunOverrides = {}): RunTrace {
  const base = startedAt * 100_000;
  return fixtureTrace({
    run: { startedAt, task: FIND_FILE_TASK, inputTokens: 4_000, turns: 5, toolCalls: 4, durationMs: 4_000, claimedSuccess: 1, claimedFailure: 1, ...overrides },
    steps: [
      { tool: 'search', turn: 1, args: { query: 'ThemeProvider' }, argsSummary: '{"query":"ThemeProvider"}', resultTokens: 50, startedAtMs: base, durationMs: STEP_DURATION_MS },
      {
        tool: 'read', turn: 2, args: { path: 'src/theme.ts' }, argsSummary: '{"path":"src/theme.ts"}', ok: false, errorCategory: 'thrown', errorCode: 'not_found', resultTokens: 20,
        startedAtMs: base + STEP_GAP_MS, durationMs: STEP_DURATION_MS, outcome: { success: false, answer: 'not there', source: 'previous' },
      },
      { tool: 'search', turn: 3, args: { query: 'ThemeProvider export' }, argsSummary: '{"query":"ThemeProvider export"}', resultTokens: 50, startedAtMs: base + 2 * STEP_GAP_MS, durationMs: STEP_DURATION_MS },
      {
        tool: 'read', turn: 4, args: { path: 'src/providers/ThemeProvider.tsx' }, argsSummary: '{"path":"src/providers/ThemeProvider.tsx"}', resultTokens: 300,
        startedAtMs: base + 3 * STEP_GAP_MS, durationMs: STEP_DURATION_MS, outcome: { success: true, answer: 'src/providers/ThemeProvider.tsx', source: 'directive' },
      },
    ],
  });
}

/** search -> read (found): the same task solved directly, over two turns. */
export function directRun(startedAt: number, overrides: RunOverrides = {}): RunTrace {
  const base = startedAt * 100_000;
  return fixtureTrace({
    run: { startedAt, task: 'Find which file defines the ThemeProvider', inputTokens: 1_500, turns: 3, toolCalls: 2, durationMs: 1_500, claimedSuccess: 1, ...overrides },
    steps: [
      { tool: 'search', turn: 1, args: { query: 'ThemeProvider' }, argsSummary: '{"query":"ThemeProvider"}', resultTokens: 50, startedAtMs: base, durationMs: STEP_DURATION_MS },
      {
        tool: 'read', turn: 2, args: { path: 'src/providers/ThemeProvider.tsx' }, argsSummary: '{"path":"src/providers/ThemeProvider.tsx"}', resultTokens: 300,
        startedAtMs: base + STEP_GAP_MS, durationMs: STEP_DURATION_MS, outcome: { success: true, answer: 'src/providers/ThemeProvider.tsx', source: 'directive' },
      },
    ],
  });
}
