import { createAigentError, isAigentError } from '../core/aigent-error.js';
import type { ProviderEvent } from './provider-types.js';

export interface RedactSecretsParams {
  text: string;
  secrets: readonly string[];
}

export interface RedactingEventsParams {
  events: AsyncIterable<ProviderEvent>;
  secrets: readonly string[];
}

/** Stands in for every secret value found in error text. */
const REDACTED = '[REDACTED]';
/** Header names whose values are credentials (auth schemes, api keys, tokens). */
const SECRET_HEADER_NAME = /authorization|api[-_]?key|token|secret/i;
/** `Bearer abc` → `abc`, so a server echoing only the bare token is caught too. */
const AUTH_SCHEME_PREFIX = /^\s*[A-Za-z]+\s+/;
/**
 * Shorter values are not treated as secrets: replacing a placeholder such as `none` or `x` everywhere would mangle
 * the message (real API keys are far longer).
 */
const MIN_SECRET_LENGTH = 8;

/** Credential values from request headers, including the bare token of an `authorization: <scheme> <token>` header. */
export function collectSecrets(headers: Record<string, string>): string[] {
  const values = Object.entries(headers)
    .filter(([name]) => SECRET_HEADER_NAME.test(name))
    .flatMap(([, value]) => {
      const token = value.replace(AUTH_SCHEME_PREFIX, '').trim();
      return token.length < MIN_SECRET_LENGTH ? [] : [value.trim(), token];
    });
  // Longest first, so a full `Bearer <token>` is replaced before the bare token inside it.
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

/** Replaces every occurrence of every secret with `[REDACTED]`. */
export function redactSecrets(params: RedactSecretsParams): string {
  const { text, secrets } = params;
  return secrets.reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED), text);
}

function redactDetails(params: { details: Record<string, unknown>; secrets: readonly string[] }): Record<string, unknown> {
  const { details, secrets } = params;
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typeof value === 'string' ? redactSecrets({ text: value, secrets }) : value]));
}

/** Returns `error` with secrets removed from its message and string details; anything else is returned unchanged. */
function redactErrorSecrets(params: { error: unknown; secrets: readonly string[] }): unknown {
  const { error, secrets } = params;
  if (!isAigentError(error) || secrets.length === 0) return error;
  const { code, message, details } = error;
  return createAigentError({
    code,
    message: redactSecrets({ text: message, secrets }),
    ...(details == null ? {} : { details: redactDetails({ details, secrets }) }),
  });
}

/**
 * Passes `events` through, rewriting any error so it cannot carry a credential: servers and proxies sometimes echo
 * the key in error bodies or streamed error messages, and errors end up in logs.
 */
export async function* redactingErrors(params: RedactingEventsParams): AsyncGenerator<ProviderEvent> {
  const { events, secrets } = params;
  try {
    yield* events;
  } catch (error) {
    throw redactErrorSecrets({ error, secrets });
  }
}
