import type { FinishReason, Provider, ProviderRequest, ThinkingBlock, ToolCall, Usage } from '../../providers/provider-types.js';

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

/**
 * Thinking that must survive a tool round trip; it runs only for providers declaring `capabilities.thinkingBlocks`.
 * On its first `stream` call the subject streams `blocks` in order (a `thinking` block's text as deltas, then its
 * signature; a `redacted-thinking` block's data whole), then `call`, finishing with `tool_calls`. On its second call it
 * MUST answer with `answer` (one text delta per chunk) only when the request's assistant turn carries `blocks`
 * unmodified ahead of its tool call, and fail with HTTP 400 otherwise, as the Anthropic Messages API does.
 */
export interface ThinkingRoundTripContractScenario {
  kind: 'thinking-round-trip';
  blocks: ThinkingBlock[];
  call: ToolCall;
  answer: string[];
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
  | ThinkingRoundTripContractScenario
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
