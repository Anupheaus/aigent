import type { ProviderRequest, ToolCall } from '../../providers/provider-types.js';
import type {
  LengthContractScenario, MalformedToolArgsContractScenario, NetworkErrorContractScenario, SlowTextContractScenario, TextContractScenario,
  ThinkingContractScenario, ThinkingRoundTripContractScenario, ToolCallsContractScenario, TruncatedStreamContractScenario,
} from './provider-contract-types.js';

/** The scenarios the provider contract suite gives each subject, with the request it streams them for. */
export const TEXT_SCENARIO: TextContractScenario = {
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

export const TOOL_CALLS_SCENARIO: ToolCallsContractScenario = {
  kind: 'tool-calls',
  calls: TOOL_CALLS,
  argumentFragments: TOOL_CALLS.map(({ args }) => fragmentText(JSON.stringify(args))),
  usage: { inputTokens: 210, outputTokens: 48, cachedTokens: 0 },
};

const MALFORMED_RAW_ARGS = '{"query": "cats", "limit": ';
export const MALFORMED_SCENARIO: MalformedToolArgsContractScenario = {
  kind: 'malformed-tool-args', name: 'search', rawArgs: MALFORMED_RAW_ARGS, rawArgsFragments: fragmentText(MALFORMED_RAW_ARGS),
};

export const THINKING_SCENARIO: ThinkingContractScenario = {
  kind: 'thinking',
  thinking: ['The user ', 'greets me; ', 'reply é.'],
  chunks: ['Hi ', 'there'],
  usage: { inputTokens: 40, outputTokens: 22, cachedTokens: 0 },
};

export const ROUND_TRIP_SCENARIO: ThinkingRoundTripContractScenario = {
  kind: 'thinking-round-trip',
  blocks: [
    // Leading and trailing whitespace and a newline: a provider that trims or re-encodes the text breaks the signature.
    { type: 'thinking', thinking: ' Look it up first.\nThen answer é. ', signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgx+/sig==' },
    { type: 'redacted-thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIw==' },
  ],
  call: { id: 'call_lookup_1', name: 'search', args: { query: 'cats' } },
  answer: ['Found ', 'them.'],
  usage: { inputTokens: 60, outputTokens: 12, cachedTokens: 0 },
};

export const LENGTH_SCENARIO: LengthContractScenario = {
  kind: 'length',
  chunks: ['This answer ', 'is cut ', 'off at the'],
  usage: { inputTokens: 30, outputTokens: 16, cachedTokens: 0 },
};

export const TRUNCATED_SCENARIO: TruncatedStreamContractScenario = { kind: 'truncated-stream' };

export const NETWORK_ERROR_SCENARIO: NetworkErrorContractScenario = { kind: 'network-error', chunks: ['partial ', 'answer'] };

/** Long enough that timer jitter is small next to it, short enough to keep the suite quick. */
export const SLOW_CHUNK_DELAY_MS = 50;
export const SLOW_SCENARIO: SlowTextContractScenario = {
  kind: 'slow-text',
  chunks: ['one ', 'two ', 'three ', 'four ', 'five ', 'six ', 'seven ', 'eight'],
  delayMs: SLOW_CHUNK_DELAY_MS,
};
/**
 * How long after an abort the stream may take to reject: two chunk delays. A provider that keeps reading the rest of
 * the slow stream (six more chunks) before throwing takes far longer.
 */
export const ABORT_BUDGET_MS = SLOW_CHUNK_DELAY_MS * 2;

/** Statuses the suite checks, with whether a caller may retry them. */
export const HTTP_ERROR_CASES = [
  { status: 400, isRetryable: false },
  { status: 401, isRetryable: false },
  { status: 429, isRetryable: true },
  { status: 500, isRetryable: true },
];

export const CONTRACT_REQUEST: ProviderRequest = {
  model: 'contract-model',
  messages: [{ role: 'system', text: 'You are tested.' }, { role: 'user', text: 'Hello' }],
  tools: [{ name: 'search', description: 'Search', parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: true }],
};

/** The slice of vitest's `it` the suite needs, so `it` and `it.skip` are interchangeable. */
