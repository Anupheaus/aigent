import { describe, expect, it } from 'vitest';
import { isAigentError } from '../../core/aigent-error.js';
import type { AigentError, AigentErrorCode } from '../../core/aigent-error.js';
import type { Provider, ProviderEvent, ProviderRequest, ToolCall, Usage } from '../../providers/provider-types.js';

/** A plain text answer. The subject should deliver `chunks` as separate text deltas. */
export interface TextContractScenario {
  kind: 'text';
  chunks: string[];
  usage: Usage;
}

/**
 * Parallel tool calls with object `args`. A wire-level subject should split each call's JSON arguments across many
 * stream messages and interleave the calls, as real servers do.
 */
export interface ToolCallsContractScenario {
  kind: 'tool-calls';
  calls: ToolCall[];
  usage: Usage;
}

/** One tool call whose arguments are not valid JSON; they must reach the consumer as the raw string. */
export interface MalformedToolArgsContractScenario {
  kind: 'malformed-tool-args';
  name: string;
  rawArgs: string;
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

/** Text whose chunks arrive with real delays (tens of milliseconds), so an abort can land mid-stream. */
export interface SlowTextContractScenario {
  kind: 'slow-text';
  chunks: string[];
}

/** A situation the subject must reproduce (usually by serving a fixture over a fake `fetch`). */
export type ContractScenario =
  | TextContractScenario
  | ToolCallsContractScenario
  | MalformedToolArgsContractScenario
  | HttpErrorContractScenario
  | TruncatedStreamContractScenario
  | SlowTextContractScenario;

export type ContractScenarioKind = ContractScenario['kind'];

/** A provider implementation under test. */
export interface ContractSubject {
  /** Shown in the vitest describe block. */
  name: string;
  /** Builds a fresh provider that reproduces `scenario` on its first `stream` call. */
  create(scenario: ContractScenario): Provider;
  /** Scenario kinds that cannot apply to this subject (e.g. HTTP errors for an in-memory fake); their tests are skipped. */
  skip?: ContractScenarioKind[];
}

const TEXT_SCENARIO: TextContractScenario = {
  kind: 'text',
  chunks: ['Hel', 'lo, ', 'wor', 'ld — ', '日本 😀'],
  usage: { inputTokens: 120, outputTokens: 34, cachedTokens: 64 },
};

const TOOL_CALLS_SCENARIO: ToolCallsContractScenario = {
  kind: 'tool-calls',
  calls: [
    { id: 'call_search_1', name: 'search', args: { query: 'cats and dogs', limit: 5, filters: { lang: 'en' } } },
    { id: 'call_lookup_2', name: 'lookup', args: { ids: ['a-1', 'b-2', 'c-3'], verbose: true } },
    { id: 'call_note_3', name: 'note', args: { text: 'quoted "value" with é' } },
  ],
  usage: { inputTokens: 210, outputTokens: 48, cachedTokens: 0 },
};

const MALFORMED_SCENARIO: MalformedToolArgsContractScenario = { kind: 'malformed-tool-args', name: 'search', rawArgs: '{"query": "cats", "limit": ' };

const TRUNCATED_SCENARIO: TruncatedStreamContractScenario = { kind: 'truncated-stream' };

const SLOW_SCENARIO: SlowTextContractScenario = { kind: 'slow-text', chunks: ['one ', 'two ', 'three ', 'four ', 'five ', 'six'] };

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

function expectSingleTerminalDone(params: { events: ProviderEvent[]; finishReason: 'stop' | 'tool_calls' }): void {
  const { events, finishReason } = params;
  expect(eventsOfType({ events, type: 'done' })).toHaveLength(1);
  expect(events.at(-1)).toEqual({ type: 'done', finishReason });
}

/**
 * Registers vitest tests every `Provider` implementation must pass: streaming text and usage, parallel and malformed
 * tool calls, HTTP failures, truncated streams and abort. Call it at the top level of a `*.tests.ts` file.
 */
export function describeProviderContract(subject: ContractSubject): void {
  const { name, create, skip = [] } = subject;
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

    testFor('truncated-stream')('rejects a stream that ends without its terminal event as provider_failed', async () => {
      const { events, error } = await consume({ provider: create(structuredClone(TRUNCATED_SCENARIO)) });
      expectAigentError({ error, code: 'provider_failed' });
      expect(eventsOfType({ events, type: 'done' })).toEqual([]);
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
