import type { ProviderEvent } from '../providers/provider-types.js';
import { createAigentError } from './aigent-error.js';

export interface OpenStreamIteratorParams {
  /** Calls the provider; may throw synchronously (a plain function that validates before returning a generator). */
  open(signal: AbortSignal): AsyncIterable<ProviderEvent>;
  signal: AbortSignal;
  /** Names the stream in the error, e.g. `anthropic:claude-sonnet-5-5`. */
  label: string;
}

function describeKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Opens a provider stream and returns its iterator. Callers must call this inside the `try` that releases what they
 * hold (a scheduler lease, listeners): a provider may throw here, before any iteration. A synchronous throw is
 * rethrown unchanged so a retryable one is still retried; a return value that is not an async iterable (a contract
 * breach) fails with a non-retryable `provider_failed` naming what came back.
 */
export function openStreamIterator(params: OpenStreamIteratorParams): AsyncIterator<ProviderEvent> {
  const { open, signal, label } = params;
  const events: unknown = open(signal);
  const createIterator = events == null ? undefined : (events as Partial<AsyncIterable<ProviderEvent>>)[Symbol.asyncIterator];
  if (typeof createIterator !== 'function') {
    throw createAigentError({
      code: 'provider_failed',
      message: `Provider '${label}' stream() returned ${describeKind(events)}, which is not an async iterable; Provider.stream must return an AsyncIterable of provider events`,
      details: { retryable: false },
    });
  }
  return createIterator.call(events);
}
