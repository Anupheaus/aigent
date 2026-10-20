import { describe, expect, it } from 'vitest';
import { isAigentError } from '../../core/aigent-error.js';
import type { AigentError, AigentErrorCode } from '../../core/aigent-error.js';
import type { FinishReason, Provider, ProviderEvent, ProviderRequest, ToolCall, Usage } from '../../providers/provider-types.js';

/** A plain text answer. The subject should deliver `chunks` as separate text deltas. */
export interface TextContractScenario {
  kind: 'text';
  chunks: string[];
  usage: Usage;
}

/**
 * Parallel tool calls with object `args`. A wire-level subject MUST stream `argumentFragments[n]` as separate argument
 * deltas for `calls[n]` (in order), interleaving the calls round-robin, and deliver the body in small byte chunks (see
 * `chunkBytes`), as real servers do. The suite splits the JSON at awkward points so a subject cannot pass by sending
 * each call's arguments whole.
 */
export interface ToolCallsContractScenario {
  kind: 'tool-calls';
  calls: ToolCall[];
  /** The JSON text of each call's `args`, pre-split; joining `argumentFragments[n]` gives `JSON.stringify(calls[n].args)`. */
  argumentFragments: string[][];
  usage: Usage;
}

/**
 * One tool call whose arguments are not valid JSON; they must reach the consumer as the raw string. A wire-level
 * subject MUST stream `rawArgsFragments` as separate argument deltas.
 */
export interface MalformedToolArgsContractScenario {
  kind: 'malformed-tool-args';
  name: string;
  rawArgs: string;
  /** `rawArgs` pre-split; joining gives `rawArgs`. */
  rawArgsFragments: string[];
}

/** Reasoning ("thinking") deltas, then a text answer. Both must stream as their own event types. */
export interface ThinkingContractScenario {
  kind: 'thinking';
  thinking: string[];
  chunks: string[];
  usage: Usage;
}

/** A text answer cut off by the output token limit (`length` / `max_tokens`); it must finish with `done(length)`. */
export interface LengthContractScenario {
  kind: 'length';
  chunks: string[];
  usage: Usage;
}

/** Text deltas, then the connection fails (the response body errors) before the provider's terminal event. */
export interface NetworkErrorContractScenario {
  kind: 'network-error';
  chunks: string[];
}

/** The server answers with this non-2xx HTTP status. */
export interface HttpErrorContractScenario {
  kind: 'http-error';
  status: number;
}

/** The stream ends cleanly at the transport level but without the provider's terminal event. */
export interface TruncatedStreamContractScenario {
  kind: 'truncated-stream';
}

/**
 * Text whose chunks arrive with real delays, so an abort can land mid-stream. The subject MUST wait `delayMs` before
 * delivering each chunk (one chunk per text delta); the suite times abort handling against it.
 */
export interface SlowTextContractScenario {
  kind: 'slow-text';
  chunks: string[];
  /** Pause before each chunk, in milliseconds. */
  delayMs: number;
}

/** A situation the subject must reproduce (usually by serving a fixture over a fake `fetch`). */
export type ContractScenario =
  | TextContractScenario
  | ToolCallsContractScenario
  | MalformedToolArgsContractScenario
  | ThinkingContractScenario
  | LengthContractScenario
  | HttpErrorContractScenario
  | TruncatedStreamContractScenario
  | NetworkErrorContractScenario
  | SlowTextContractScenario;

export type ContractScenarioKind = ContractScenario['kind'];

/** What an HTTP subject can report about the response it served. */
export interface ContractObservation {
  /** True once the provider cancelled the response body (it must, on abort or when the consumer stops early). */
  isBodyCancelled: boolean;
}

/** A provider implementation under test. */
export interface ContractSubject {
  /** Shown in the vitest describe block. */
  name: string;
  /** Builds a fresh provider that reproduces `scenario` on its first `stream` call. */
  create(scenario: ContractScenario): Provider;
  /** Scenario kinds that cannot apply to this subject (e.g. HTTP errors for an in-memory fake); their tests are skipped. */
  skip?: ContractScenarioKind[];
  /**
   * Reports on the response served to the provider most recently returned by `create`. HTTP subjects should provide
   * it so the suite can prove the body is cancelled (an uncancelled body leaks the connection).
   */
  observe?(): ContractObservation;
}

const TEXT_SCENARIO: TextContractScenario = {
  kind: 'text',
  chunks: ['Hel', 'lo, ', 'wor', 'ld — ', '日本 😀'],
  usage: { inputTokens: 120, outputTokens: 34, cachedTokens: 64 },
};

/** Two characters per argument fragment cuts keys, escapes (`\"`) and numbers mid-way. */
const ARGUMENT_FRAGMENT_LENGTH = 2;

/** Splits by code point, never inside a surrogate pair: servers send valid UTF-8, so a fragment never holds half a character. */
function fragmentText(text: string): string[] {
  const codePoints = Array.from(text);
  const fragments: string[] = [];
  for (let start = 0; start < codePoints.length; start += ARGUMENT_FRAGMENT_LENGTH) {
    fragments.push(codePoints.slice(start, start + ARGUMENT_FRAGMENT_LENGTH).join(''));
  }
  return fragments;
}

const TOOL_CALLS: ToolCall[] = [
  { id: 'call_search_1', name: 'search', args: { query: 'cats and dogs', limit: 5, filters: { lang: 'en' } } },
  { id: 'call_lookup_2', name: 'lookup', args: { ids: ['a-1', 'b-2', 'c-3'], verbose: true } },
  { id: 'call_note_3', name: 'note', args: { text: 'quoted "value" with é and 日本 😀' } },
];

const TOOL_CALLS_SCENARIO: ToolCallsContractScenario = {
  kind: 'tool-calls',
  calls: TOOL_CALLS,
  argumentFragments: TOOL_CALLS.map(({ args }) => fragmentText(JSON.stringify(args))),
  usage: { inputTokens: 210, outputTokens: 48, cachedTokens: 0 },
};

const MALFORMED_RAW_ARGS = '{"query": "cats", "limit": ';
const MALFORMED_SCENARIO: MalformedToolArgsContractScenario = {
  kind: 'malformed-tool-args', name: 'search', rawArgs: MALFORMED_RAW_ARGS, rawArgsFragments: fragmentText(MALFORMED_RAW_ARGS),
};

const THINKING_SCENARIO: ThinkingContractScenario = {
  kind: 'thinking',
  thinking: ['The user ', 'greets me; ', 'reply é.'],
  chunks: ['Hi ', 'there'],
  usage: { inputTokens: 40, outputTokens: 22, cachedTokens: 0 },
};

const LENGTH_SCENARIO: LengthContractScenario = {
  kind: 'length',
  chunks: ['This answer ', 'is cut ', 'off at the'],
  usage: { inputTokens: 30, outputTokens: 16, cachedTokens: 0 },
};

const TRUNCATED_SCENARIO: TruncatedStreamContractScenario = { kind: 'truncated-stream' };

const NETWORK_ERROR_SCENARIO: NetworkErrorContractScenario = { kind: 'network-error', chunks: ['partial ', 'answer'] };

/** Long enough that timer jitter is small next to it, short enough to keep the suite quick. */
const SLOW_CHUNK_DELAY_MS = 50;
const SLOW_SCENARIO: SlowTextContractScenario = {
  kind: 'slow-text',
  chunks: ['one ', 'two ', 'three ', 'four ', 'five ', 'six ', 'seven ', 'eight'],
  delayMs: SLOW_CHUNK_DELAY_MS,
};
/**
 * How long after an abort the stream may take to reject: two chunk delays. A provider that keeps reading the rest of
 * the slow stream (six more chunks) before throwing takes far longer.
 */
const ABORT_BUDGET_MS = SLOW_CHUNK_DELAY_MS * 2;

/** Statuses the suite checks, with whether a caller may retry them. */
const HTTP_ERROR_CASES = [
  { status: 400, isRetryable: false },
  { status: 401, isRetryable: false },
  { status: 429, isRetryable: true },
  { status: 500, isRetryable: true },
];

const CONTRACT_REQUEST: ProviderRequest = {
  model: 'contract-model',
  messages: [{ role: 'system', text: 'You are tested.' }, { role: 'user', text: 'Hello' }],
  tools: [{ name: 'search', description: 'Search', parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: true }],
};

/** The slice of vitest's `it` the suite needs, so `it` and `it.skip` are interchangeable. */
type ContractTest = (title: string, run: () => Promise<void>) => void;

interface StreamOutcome {
  events: ProviderEvent[];
  error?: unknown;
}

/** Consumes a whole stream, keeping every event seen before a rejection. */
async function consume(params: { provider: Provider; signal?: AbortSignal }): Promise<StreamOutcome> {
  const { provider, signal = new AbortController().signal } = params;
  const events: ProviderEvent[] = [];
  try {
    for await (const event of provider.stream(structuredClone(CONTRACT_REQUEST), signal)) events.push(event);
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

  describe(`provider contract: ${name}`, () => {
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
