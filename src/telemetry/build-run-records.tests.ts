import { describe, expect, it } from 'vitest';
import type { TaskResult } from '../core/agent-types.js';
import type { ProviderTarget } from '../core/open-turn-stream.js';
import { createFakeProvider } from '../testing/fake-provider.js';
import { buildRunRecords } from './build-run-records.js';
import type { BuildRunRecordsParams, RunFacts } from './build-run-records.js';
import type { RunRecord, TraceStep } from './run-record.js';
import { parseRunRecord, parseTraceRecord } from './run-record-schema.js';

const RESULT: TaskResult = {
  status: 'completed', answer: 'the answer', runId: 'run_1', responseId: 'resp_1', agentName: 'helper', instanceId: 'agent_1',
  errors: [{ category: 'thrown', code: 'x', message: 'm', retryable: false }],
  usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, turns: 1, toolCalls: 2, toolCallsPerTurn: 2, retries: 0, fallbacks: 0, durationMs: 50 },
};

function step(overrides: Partial<TraceStep> & Pick<TraceStep, 'index' | 'callId'>): TraceStep {
  return { turn: 1, tool: 'read', argsSummary: '{}', ok: true, resultBytes: 1, resultTokens: 1, truncated: false, durationMs: 10, startedAtMs: 100, ...overrides };
}

const STEPS: TraceStep[] = [
  step({ index: 0, callId: 'm', tool: 'aigent_multi', durationMs: 30 }),
  step({ index: 1, callId: 'a', parentCallId: 'm', durationMs: 20 }),
  step({ index: 2, callId: 'b', durationMs: 5 }),
];

const FACTS: RunFacts = { timings: { startedAt: 100, firstTokenMs: 3, modelMs: 12, queuedMs: 4 }, steps: STEPS, captureContent: true, recordedAt: 200 };

function target(overrides: Partial<ProviderTarget> & Pick<ProviderTarget, 'label'>): ProviderTarget {
  return { provider: createFakeProvider({ turns: [] }), model: 'm', warnings: [], dropped: [], ...overrides };
}

function params(overrides: Partial<BuildRunRecordsParams> = {}): BuildRunRecordsParams {
  return {
    input: { task: 'find the file', label: 'nightly', scope: { tenant: 't1' }, unattended: true },
    result: RESULT,
    agent: { agentVersion: 'abc', version: 'v2' },
    targets: { primary: target({ label: 'fake:m', settings: { temperature: 0.2 }, dropped: ['seed'] }), fallbacks: [], runtimeSettings: { temperature: 0.2, contextSize: 8_000, showThinking: false } },
    facts: FACTS,
    ...overrides,
  };
}

describe('buildRunRecords', () => {
  it('builds a versioned run record with identity, settings as sent, timings, counts and content', () => {
    const { run } = buildRunRecords(params());
    expect(run).toEqual({
      schemaVersion: 1, runId: 'run_1', responseId: 'resp_1', agentName: 'helper', instanceId: 'agent_1', mode: 'task', agentVersion: 'abc', version: 'v2',
      label: 'nightly', scope: { tenant: 't1' }, model: 'fake:m', settings: { temperature: 0.2 }, droppedSettings: ['seed'],
      runtimeSettings: { contextSize: 8_000, showThinking: false }, unattended: true, status: 'completed', usage: RESULT.usage,
      // toolMs sums top-level steps only: an inner aigent_multi call is part of its parent's time.
      timings: { startedAt: 100, firstTokenMs: 3, durationMs: 50, modelMs: 12, toolMs: 35, queuedMs: 4 },
      stepCount: 3, failureCount: 1, outcomeSummary: { claimedSuccess: 0, claimedFailure: 0 }, task: 'find the file', answer: 'the answer', recordedAt: 200,
    } satisfies RunRecord);
  });

  it('builds the trace record with the same identity and every step', () => {
    const { trace } = buildRunRecords(params());
    expect(trace).toEqual({ schemaVersion: 1, runId: 'run_1', agentName: 'helper', instanceId: 'agent_1', mode: 'task', agentVersion: 'abc', scope: { tenant: 't1' }, recordedAt: 200, steps: STEPS });
  });

  it('leaves optional fields out when nothing was set, and defaults unattended to false', () => {
    const { run, trace } = buildRunRecords(params({ input: { task: 'x' }, agent: { agentVersion: 'abc' }, targets: { primary: target({ label: 'fake:m' }), fallbacks: [], runtimeSettings: {} }, facts: { ...FACTS, timings: { startedAt: 1, modelMs: 0, queuedMs: 0 } } }));
    expect(run.settings).toEqual({});
    expect(run.unattended).toBe(false);
    for (const field of ['droppedSettings', 'runtimeSettings', 'fallbacks', 'version', 'label', 'scope', 'expiresAt']) expect(run).not.toHaveProperty(field);
    expect(run.timings).not.toHaveProperty('firstTokenMs');
    expect(trace).not.toHaveProperty('scope');
  });

  it('records each fallback the run used with what it was sent', () => {
    const { run } = buildRunRecords(params({
      targets: {
        primary: target({ label: 'a:m', settings: { maxOutputTokens: 10 } }),
        fallbacks: [target({ label: 'b:m', settings: { maxOutputTokens: 10 }, dropped: ['temperature'] }), target({ label: 'c:m' })],
        runtimeSettings: {},
      },
    }));
    expect(run.fallbacks).toEqual([{ model: 'b:m', settings: { maxOutputTokens: 10 }, droppedSettings: ['temperature'] }, { model: 'c:m', settings: {} }]);
  });

  it('stores no task or answer without content capture', () => {
    const { run } = buildRunRecords(params({ facts: { ...FACTS, captureContent: false } }));
    expect(run).not.toHaveProperty('task');
    expect(run).not.toHaveProperty('answer');
  });

  it('stamps expiresAt on both records when retention is configured', () => {
    const { run, trace } = buildRunRecords(params({ facts: { ...FACTS, expiresAt: 5_000 } }));
    expect(run.expiresAt).toBe(5_000);
    expect(trace.expiresAt).toBe(5_000);
  });

  it('round-trips both records through the stored-record schema unchanged', () => {
    const { run, trace } = buildRunRecords(params({ facts: { ...FACTS, expiresAt: 5_000 } }));
    const stored = JSON.parse(JSON.stringify({ run, trace }));
    expect(parseRunRecord({ collection: 'runs', key: 'run_1', value: stored.run })).toEqual(run);
    expect(parseTraceRecord({ collection: 'traces', key: 'run_1', value: stored.trace })).toEqual(trace);
  });

  it('rejects a stored record of another schema version, naming the record and field', () => {
    const { run } = buildRunRecords(params());
    expect(() => parseRunRecord({ collection: 'runs', key: 'run_1', value: { ...run, schemaVersion: 2 } })).toThrow(expect.objectContaining({
      code: 'invalid_input', message: expect.stringMatching(/'runs\/run_1'.*schema version 1.*schemaVersion/),
    }));
  });
});
