import { describe, expect, it } from 'vitest';
import { isAigentError } from '../../core/aigent-error.js';
import type { AigentError, AigentErrorCode } from '../../core/aigent-error.js';
import { PROVIDER_SETTING_KEYS } from '../../providers/provider-settings.js';
import type { FinishReason, Provider, ProviderEvent, ProviderRequest, ThinkingBlock } from '../../providers/provider-types.js';
import {
  ABORT_BUDGET_MS, CONTRACT_REQUEST, HTTP_ERROR_CASES, LENGTH_SCENARIO, MALFORMED_SCENARIO, NETWORK_ERROR_SCENARIO, ROUND_TRIP_SCENARIO,
  SLOW_CHUNK_DELAY_MS, SLOW_SCENARIO, TEXT_SCENARIO, THINKING_SCENARIO, TOOL_CALLS_SCENARIO, TRUNCATED_SCENARIO,
} from './provider-contract-scenarios.js';
import type { ContractScenarioKind, ContractSubject } from './provider-contract-types.js';

/** The scenario and observation types, also importable from here (where the suite is). */
export type { ContractObservation, ContractScenario } from './provider-contract-types.js';

type ContractTest = (title: string, run: () => Promise<void>) => void;

interface StreamOutcome {
  events: ProviderEvent[];
  error?: unknown;
}

/** Consumes a whole stream, keeping every event seen before a rejection. */
async function consume(params: { provider: Provider; signal?: AbortSignal; request?: ProviderRequest }): Promise<StreamOutcome> {
  const { provider, signal = new AbortController().signal, request = CONTRACT_REQUEST } = params;
  const events: ProviderEvent[] = [];
  try {
    for await (const event of provider.stream(structuredClone(request), signal)) events.push(event);
    return { events };
  } catch (error) {
    return { events, error };
  }
}

function expectAigentError(params: { error: unknown; code: AigentErrorCode }): AigentError {
  const { error, code } = params;
  expect(isAigentError(error), `expected an AigentError '${code}', got ${String(error)}`).toBe(true);
  const aigentError = error as AigentError;
  expect(aigentError.code).toBe(code);
  return aigentError;
}

function expectCompleted(outcome: StreamOutcome): ProviderEvent[] {
  const { events, error } = outcome;
  expect(error, `stream rejected: ${String(error)}`).toBeUndefined();
  return events;
}

function eventsOfType<TType extends ProviderEvent['type']>(params: { events: ProviderEvent[]; type: TType }): Extract<ProviderEvent, { type: TType }>[] {
  const { events, type } = params;
  return events.filter((event): event is Extract<ProviderEvent, { type: TType }> => event.type === type);
}

function expectSingleTerminalDone(params: { events: ProviderEvent[]; finishReason: FinishReason }): void {
  const { events, finishReason } = params;
  expect(eventsOfType({ events, type: 'done' })).toHaveLength(1);
  expect(events.at(-1)).toEqual({ type: 'done', finishReason });
}

function joinedText(params: { events: ProviderEvent[]; type: 'text-delta' | 'thinking-delta' }): string {
  return eventsOfType(params).map(({ text }) => text).join('');
}

/** The contract conversation continued with the round trip's assistant turn (its blocks as streamed) and the tool result. */
function roundTripReplay(blocks: ThinkingBlock[]): ProviderRequest {
  const { call } = ROUND_TRIP_SCENARIO;
  return {
    ...CONTRACT_REQUEST,
    messages: [
      ...CONTRACT_REQUEST.messages,
      { role: 'assistant', text: '', toolCalls: [call], thinkingBlocks: blocks },
      { role: 'tool', toolCallId: call.id, text: JSON.stringify({ id: call.id, tool: call.name, ok: true, result: 'two cats' }) },
    ],
  };
}

function thinkingTextOf(blocks: ThinkingBlock[]): string {
  return blocks.map(block => (block.type === 'thinking' ? block.thinking : '')).join('');
}

/** Only checked when the subject can observe its response body. */
function expectBodyCancelled(observe: ContractSubject['observe']): void {
  if (observe == null) return;
  expect(observe().isBodyCancelled, 'the response body was not cancelled').toBe(true);
}

interface TimedAbortOutcome {
  error: unknown;
  /** Milliseconds from the abort firing to the stream rejecting. */
  rejectionDelayMs: number;
}

/** Aborts from a timer half a chunk delay after the first text delta, while the provider is waiting on the network. */
async function abortWhileWaiting(provider: Provider): Promise<TimedAbortOutcome> {
  const controller = new AbortController();
  let isAbortScheduled = false;
  // Stays NaN (failing the timing checks) if the stream rejects before the abort fires.
  let abortedAt = Number.NaN;
  try {
    for await (const event of provider.stream(structuredClone(CONTRACT_REQUEST), controller.signal)) {
      if (event.type !== 'text-delta' || isAbortScheduled) continue;
      isAbortScheduled = true;
      setTimeout(() => { abortedAt = performance.now(); controller.abort(); }, SLOW_CHUNK_DELAY_MS / 2);
    }
    return { error: undefined, rejectionDelayMs: Number.NaN };
  } catch (error) {
    return { error, rejectionDelayMs: performance.now() - abortedAt };
  }
}

/**
 * Registers vitest tests every `Provider` implementation must pass: streaming text, thinking and usage, `length`
 * finishes, parallel and malformed tool calls, HTTP failures, truncated streams, mid-stream network errors, and prompt
 * abort with the body cancelled. Call it at the top level of a `*.tests.ts` file.
 */
export function describeProviderContract(subject: ContractSubject): void {
  const { name, create, skip = [], observe } = subject;
  const testFor = (kind: ContractScenarioKind): ContractTest => (skip.includes(kind) ? it.skip : it);
  const roundTripTest = skip.includes('thinking-round-trip') ? it.skip : it;

  describe(`provider contract: ${name}`, () => {
    it('declares capabilities.supportedSettings as a list of known setting keys', () => {
      const { supportedSettings } = create(structuredClone(TEXT_SCENARIO)).capabilities;
      expect(Array.isArray(supportedSettings), 'capabilities.supportedSettings must be an array (use [] for none)').toBe(true);
      expect(supportedSettings.filter(key => !PROVIDER_SETTING_KEYS.includes(key)), 'unknown setting keys').toEqual([]);
    });

    roundTripTest('emits completed thinking blocks before the tool call and replays them verbatim on the next request', async context => {
      const provider = create(structuredClone(ROUND_TRIP_SCENARIO));
      // Only providers that declare thinking blocks promise to round-trip them.
      if (provider.capabilities.thinkingBlocks !== true) { context.skip(); return; }
      const first = expectCompleted(await consume({ provider }));
      const blocks = eventsOfType({ events: first, type: 'thinking-block' }).map(({ block }) => block);
      expect(blocks).toEqual(ROUND_TRIP_SCENARIO.blocks);
      expect(joinedText({ events: first, type: 'thinking-delta' })).toBe(thinkingTextOf(ROUND_TRIP_SCENARIO.blocks));
      expect(eventsOfType({ events: first, type: 'tool-call' }).map(({ call }) => call)).toEqual([ROUND_TRIP_SCENARIO.call]);
      const lastBlockAt = first.map(({ type }) => type).lastIndexOf('thinking-block');
      expect(lastBlockAt, 'thinking blocks must be emitted before the tool call').toBeLessThan(first.findIndex(({ type }) => type === 'tool-call'));
      expectSingleTerminalDone({ events: first, finishReason: 'tool_calls' });

      const second = expectCompleted(await consume({ provider, request: roundTripReplay(blocks) }));
      expect(joinedText({ events: second, type: 'text-delta' })).toBe(ROUND_TRIP_SCENARIO.answer.join(''));
      expectSingleTerminalDone({ events: second, finishReason: 'stop' });
    });

    testFor('text')('streams text deltas that concatenate to the answer, one usage event, then done(stop)', async () => {
      const events = expectCompleted(await consume({ provider: create(structuredClone(TEXT_SCENARIO)) }));
      const text = eventsOfType({ events, type: 'text-delta' }).map(event => event.text).join('');
      expect(text).toBe(TEXT_SCENARIO.chunks.join(''));
      expect(eventsOfType({ events, type: 'usage' })).toEqual([{ type: 'usage', usage: TEXT_SCENARIO.usage }]);
      expect(eventsOfType({ events, type: 'tool-call' })).toEqual([]);
      expectSingleTerminalDone({ events, finishReason: 'stop' });
    });

    testFor('tool-calls')('emits exactly one tool-call per parallel call with its own id, name and parsed args', async () => {
      const events = expectCompleted(await consume({ provider: create(structuredClone(TOOL_CALLS_SCENARIO)) }));
      expect(eventsOfType({ events, type: 'tool-call' }).map(event => event.call)).toEqual(TOOL_CALLS_SCENARIO.calls);
      expect(eventsOfType({ events, type: 'usage' })).toEqual([{ type: 'usage', usage: TOOL_CALLS_SCENARIO.usage }]);
      expectSingleTerminalDone({ events, finishReason: 'tool_calls' });
    });

    testFor('malformed-tool-args')('passes unparsable tool arguments through as the raw string in a single tool-call', async () => {
      const events = expectCompleted(await consume({ provider: create(structuredClone(MALFORMED_SCENARIO)) }));
      const calls = eventsOfType({ events, type: 'tool-call' }).map(event => event.call);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ name: MALFORMED_SCENARIO.name, args: MALFORMED_SCENARIO.rawArgs });
      expect(typeof calls[0]?.id).toBe('string');
      expectSingleTerminalDone({ events, finishReason: 'tool_calls' });
    });

    testFor('thinking')('streams reasoning as thinking deltas, separate from the text answer', async () => {
      const events = expectCompleted(await consume({ provider: create(structuredClone(THINKING_SCENARIO)) }));
      expect(joinedText({ events, type: 'thinking-delta' })).toBe(THINKING_SCENARIO.thinking.join(''));
      expect(joinedText({ events, type: 'text-delta' })).toBe(THINKING_SCENARIO.chunks.join(''));
      expect(eventsOfType({ events, type: 'usage' })).toEqual([{ type: 'usage', usage: THINKING_SCENARIO.usage }]);
      expectSingleTerminalDone({ events, finishReason: 'stop' });
    });

    testFor('length')('finishes an answer cut off by the token limit with done(length), not stop', async () => {
      const events = expectCompleted(await consume({ provider: create(structuredClone(LENGTH_SCENARIO)) }));
      expect(joinedText({ events, type: 'text-delta' })).toBe(LENGTH_SCENARIO.chunks.join(''));
      expect(eventsOfType({ events, type: 'usage' })).toEqual([{ type: 'usage', usage: LENGTH_SCENARIO.usage }]);
      expectSingleTerminalDone({ events, finishReason: 'length' });
    });

    describe('HTTP errors', () => {
      HTTP_ERROR_CASES.forEach(({ status, isRetryable }) => {
        testFor('http-error')(`rejects HTTP ${status} as provider_failed with retryable ${isRetryable}`, async () => {
          const { events, error } = await consume({ provider: create({ kind: 'http-error', status }) });
          const aigentError = expectAigentError({ error, code: 'provider_failed' });
          expect(aigentError.details).toMatchObject({ status, retryable: isRetryable });
          expect(events).toEqual([]);
        });
      });
    });

    testFor('truncated-stream')('rejects a stream that ends without its terminal event as retryable provider_failed', async () => {
      const { events, error } = await consume({ provider: create(structuredClone(TRUNCATED_SCENARIO)) });
      const aigentError = expectAigentError({ error, code: 'provider_failed' });
      expect(aigentError.details).toMatchObject({ retryable: true });
      expect(eventsOfType({ events, type: 'done' })).toEqual([]);
    });

    testFor('network-error')('rejects a connection that fails mid-stream as retryable provider_failed, never done', async () => {
      const { events, error } = await consume({ provider: create(structuredClone(NETWORK_ERROR_SCENARIO)) });
      const aigentError = expectAigentError({ error, code: 'provider_failed' });
      expect(aigentError.details).toMatchObject({ retryable: true });
      expect(eventsOfType({ events, type: 'done' })).toEqual([]);
      expect(eventsOfType({ events, type: 'usage' })).toEqual([]);
    });

    testFor('slow-text')('rejects aborted and yields nothing more when aborted mid-stream', async () => {
      const controller = new AbortController();
      const provider = create(structuredClone(SLOW_SCENARIO));
      const events: ProviderEvent[] = [];
      let eventsAtAbort: number | undefined;
      const outcome = await (async (): Promise<unknown> => {
        try {
          for await (const event of provider.stream(structuredClone(CONTRACT_REQUEST), controller.signal)) {
            events.push(event);
            if (eventsAtAbort == null && event.type === 'text-delta') {
              controller.abort();
              eventsAtAbort = events.length;
            }
          }
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      expectAigentError({ error: outcome, code: 'aborted' });
      expect(eventsAtAbort).toBeDefined();
      expect(events).toHaveLength(eventsAtAbort ?? 0);
      expectBodyCancelled(observe);
    });

    testFor('slow-text')(`rejects aborted within ${ABORT_BUDGET_MS}ms of an abort that lands while waiting on the network`, async () => {
      const { error, rejectionDelayMs } = await abortWhileWaiting(create(structuredClone(SLOW_SCENARIO)));
      expectAigentError({ error, code: 'aborted' });
      expect(rejectionDelayMs).toBeGreaterThanOrEqual(0);
      expect(rejectionDelayMs, 'the provider kept reading after the abort').toBeLessThan(ABORT_BUDGET_MS);
      expectBodyCancelled(observe);
    });

    testFor('slow-text')('stops and cancels the body when the consumer stops iterating early', async () => {
      const provider = create(structuredClone(SLOW_SCENARIO));
      const events: ProviderEvent[] = [];
      for await (const event of provider.stream(structuredClone(CONTRACT_REQUEST), new AbortController().signal)) {
        events.push(event);
        if (event.type === 'text-delta') break;
      }
      expect(eventsOfType({ events, type: 'text-delta' })).toHaveLength(1);
      expectBodyCancelled(observe);
    });

    testFor('slow-text')('rejects aborted without yielding when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const { events, error } = await consume({ provider: create(structuredClone(SLOW_SCENARIO)), signal: controller.signal });
      expectAigentError({ error, code: 'aborted' });
      expect(events).toEqual([]);
    });
  });
}
