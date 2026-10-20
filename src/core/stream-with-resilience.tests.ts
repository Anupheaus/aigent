import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ProviderEvent } from '../providers/provider-types.js';
import { createAigentError } from './aigent-error.js';
import type { AigentError } from './aigent-error.js';
import { DEFAULT_RESILIENCE_POLICY } from './resilience-policy.js';
import type { ResiliencePolicy } from './resilience-policy.js';
import { streamWithResilience } from './stream-with-resilience.js';
import type { FallbackInfo, ProviderAttempt, RetryInfo } from './stream-with-resilience.js';

/** One scripted `open`: fail before any event, stream events (then maybe fail), or hang until aborted. */
type OpenScript =
  | { kind: 'fail'; error: AigentError }
  | { kind: 'events'; events: ProviderEvent[]; failAfter?: AigentError }
  | { kind: 'hang' }
  /** `open` itself throws, as a plain (non-generator) provider function that validates first does. */
  | { kind: 'throw-on-open'; error: AigentError }
  /** `open` returns something that is not an async iterable. */
  | { kind: 'non-iterable' };

interface ScriptedAttempt {
  attempt: ProviderAttempt;
  opens(): number;
  /** How many times an abandoned stream was asked to `return()`. */
  returns(): number;
}

const NO_JITTER: ResiliencePolicy = { ...DEFAULT_RESILIENCE_POLICY, jitter: 0 };
const TEXT: ProviderEvent = { type: 'text-delta', text: 'hi' };
const DONE: ProviderEvent = { type: 'done', finishReason: 'stop' };

function retryable(message = 'HTTP 503'): AigentError {
  return createAigentError({ code: 'provider_failed', message, details: { retryable: true, status: 503 } });
}

function fatal(message = 'HTTP 401'): AigentError {
  return createAigentError({ code: 'provider_failed', message, details: { retryable: false, status: 401 } });
}

function abortedError(): AigentError {
  return createAigentError({ code: 'aborted', message: 'scripted stream aborted' });
}

/** Resolves when `signal` aborts, never otherwise. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function scripted(label: string, scripts: OpenScript[]): ScriptedAttempt {
  let opens = 0;
  let returns = 0;
  const attempt: ProviderAttempt = {
    label,
    open: signal => {
      const script = scripts[opens] ?? { kind: 'fail', error: fatal(`'${label}' has no script for open ${opens + 1}`) };
      opens += 1;
      if (script.kind === 'throw-on-open') throw script.error;
      if (script.kind === 'non-iterable') return {} as AsyncIterable<ProviderEvent>;
      let index = 0;
      const iterator: AsyncIterator<ProviderEvent> = {
        next: async () => {
          if (script.kind === 'fail') throw script.error;
          if (script.kind === 'hang') { await untilAborted(signal); throw abortedError(); }
          const event = script.events[index];
          index += 1;
          if (event != null) return { done: false, value: event };
          if (script.failAfter != null) throw script.failAfter;
          return { done: true, value: undefined };
        },
        return: async () => { returns += 1; return { done: true, value: undefined }; },
      };
      return { [Symbol.asyncIterator]: () => iterator };
    },
  };
  return { attempt, opens: () => opens, returns: () => returns };
}

interface Recorder {
  delays: number[];
  retries: RetryInfo[];
  fallbacks: FallbackInfo[];
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** A sleep that records each delay and returns at once (or as soon as `signal` aborts, when `isHanging`). */
function recorder(options: { isHanging?: boolean } = {}): Recorder {
  const { isHanging = false } = options;
  const delays: number[] = [];
  return {
    delays,
    retries: [],
    fallbacks: [],
    sleep: (ms, signal) => { delays.push(ms); return isHanging ? untilAborted(signal) : Promise.resolve(); },
  };
}

interface RunParams {
  attempts: ScriptedAttempt[];
  policy?: ResiliencePolicy;
  record?: Recorder;
  signal?: AbortSignal;
  firstEventTimeoutMs?: number;
}

function stream(params: RunParams): AsyncIterable<ProviderEvent> {
  const { attempts, policy = NO_JITTER, record = recorder(), signal = new AbortController().signal, firstEventTimeoutMs } = params;
  const [first, ...rest] = attempts.map(({ attempt }) => attempt);
  if (first == null) throw new Error('at least one attempt is needed');
  return streamWithResilience({
    attempts: [first, ...rest], policy, sleep: record.sleep, random: () => 0.5, signal,
    onRetry: info => record.retries.push(info), onFallback: info => record.fallbacks.push(info), firstEventTimeoutMs,
  });
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const seen: ProviderEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

/** Lets every pending microtask chain run (one macrotask turn). */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe('streamWithResilience', () => {
  it('passes a healthy stream through untouched', async () => {
    const primary = scripted('a:m', [{ kind: 'events', events: [TEXT, DONE] }]);
    expect(await collect(stream({ attempts: [primary] }))).toEqual([TEXT, DONE]);
    expect(primary.opens()).toBe(1);
  });

  it('retries a retryable failure before the first event, with backoff, then succeeds', async () => {
    const record = recorder();
    const primary = scripted('a:m', [{ kind: 'fail', error: retryable() }, { kind: 'fail', error: retryable() }, { kind: 'events', events: [TEXT, DONE] }]);
    expect(await collect(stream({ attempts: [primary], record }))).toEqual([TEXT, DONE]);
    expect(primary.opens()).toBe(3);
    expect(record.delays).toEqual([500, 1_000]);
    expect(record.retries).toEqual([
      expect.objectContaining({ attempt: 1, delayMs: 500, label: 'a:m', reason: 'HTTP 503' }),
      expect.objectContaining({ attempt: 2, delayMs: 1_000, label: 'a:m', reason: 'HTTP 503' }),
    ]);
  });

  it('retries a provider that throws synchronously while opening, like any failure before the first event', async () => {
    const record = recorder();
    const primary = scripted('a:m', [{ kind: 'throw-on-open', error: retryable() }, { kind: 'events', events: [TEXT, DONE] }]);
    expect(await collect(stream({ attempts: [primary], record }))).toEqual([TEXT, DONE]);
    expect(primary.opens()).toBe(2);
    expect(record.retries).toEqual([expect.objectContaining({ attempt: 1, label: 'a:m', reason: 'HTTP 503' })]);
  });

  it('fails without retrying when open returns a non-iterable, naming what came back', async () => {
    const record = recorder();
    const primary = scripted('a:m', [{ kind: 'non-iterable' }]);
    await expect(collect(stream({ attempts: [primary], record }))).rejects.toMatchObject({
      code: 'provider_failed',
      message: expect.stringContaining("Provider 'a:m' stream() returned object, which is not an async iterable"),
      details: { retryable: false },
    });
    expect(primary.opens()).toBe(1);
    expect(record.retries).toEqual([]);
  });

  it('honours retryAfterMs from the error as a floor on the delay', async () => {
    const record = recorder();
    const limited = createAigentError({ code: 'provider_failed', message: 'HTTP 429', details: { retryable: true, status: 429, retryAfterMs: 7_000 } });
    const primary = scripted('a:m', [{ kind: 'fail', error: limited }, { kind: 'events', events: [DONE] }]);
    await collect(stream({ attempts: [primary], record }));
    expect(record.delays).toEqual([7_000]);
  });

  it('moves to the fallback once retries are exhausted', async () => {
    const record = recorder();
    const primary = scripted('a:m', [{ kind: 'fail', error: retryable() }, { kind: 'fail', error: retryable() }, { kind: 'fail', error: retryable('HTTP 500') }]);
    const backup = scripted('b:m', [{ kind: 'events', events: [TEXT, DONE] }]);
    expect(await collect(stream({ attempts: [primary, backup], record }))).toEqual([TEXT, DONE]);
    expect(primary.opens()).toBe(3);
    expect(backup.opens()).toBe(1);
    expect(record.fallbacks).toEqual([expect.objectContaining({ from: 'a:m', to: 'b:m', reason: 'HTTP 500' })]);
  });

  it('throws the last error when every attempt is exhausted', async () => {
    const primary = scripted('a:m', [{ kind: 'fail', error: retryable() }]);
    const backup = scripted('b:m', [{ kind: 'fail', error: retryable('backup down') }]);
    await expect(collect(stream({ attempts: [primary, backup], policy: { ...NO_JITTER, maxRetries: 0 } }))).rejects.toThrow('backup down');
  });

  it('neither retries nor falls back after a non-retryable failure by default', async () => {
    const record = recorder();
    const primary = scripted('a:m', [{ kind: 'fail', error: fatal() }]);
    const backup = scripted('b:m', [{ kind: 'events', events: [DONE] }]);
    await expect(collect(stream({ attempts: [primary, backup], record }))).rejects.toThrow('HTTP 401');
    expect(primary.opens()).toBe(1);
    expect(backup.opens()).toBe(0);
    expect(record.retries).toEqual([]);
  });

  it('falls back after a non-retryable failure when fallbackOnNonRetryable is set, still without retrying', async () => {
    const primary = scripted('a:m', [{ kind: 'fail', error: fatal() }]);
    const backup = scripted('b:m', [{ kind: 'events', events: [DONE] }]);
    expect(await collect(stream({ attempts: [primary, backup], policy: { ...NO_JITTER, fallbackOnNonRetryable: true } }))).toEqual([DONE]);
    expect(primary.opens()).toBe(1);
  });

  it('rethrows errors that are not provider failures without retrying or falling back', async () => {
    const primary = scripted('a:m', [{ kind: 'fail', error: createAigentError({ code: 'invalid_input', message: 'bad request shape' }) }]);
    const backup = scripted('b:m', [{ kind: 'events', events: [DONE] }]);
    await expect(collect(stream({ attempts: [primary, backup] }))).rejects.toThrow('bad request shape');
    expect(backup.opens()).toBe(0);
  });

  it('never retries or falls back once an event has been yielded', async () => {
    const primary = scripted('a:m', [{ kind: 'events', events: [TEXT], failAfter: retryable('dropped mid-stream') }, { kind: 'events', events: [TEXT, DONE] }]);
    const backup = scripted('b:m', [{ kind: 'events', events: [DONE] }]);
    const seen: ProviderEvent[] = [];
    const consumed = (async () => { for await (const event of stream({ attempts: [primary, backup] })) seen.push(event); })();
    await expect(consumed).rejects.toThrow('dropped mid-stream');
    expect(seen).toEqual([TEXT]);
    expect(primary.opens()).toBe(1);
    expect(backup.opens()).toBe(0);
  });

  it('treats a missing first event within firstEventTimeoutMs as a retryable timeout, aborting that attempt', async () => {
    let timerSignal: AbortSignal | undefined;
    // Elapses after a macrotask, so a stream that does answer (in microtasks) always beats the timer.
    const record: Recorder = { ...recorder(), sleep: (ms, signal) => { timerSignal = signal; record.delays.push(ms); return new Promise(resolve => setImmediate(resolve)); } };
    const primary = scripted('a:m', [{ kind: 'hang' }, { kind: 'events', events: [DONE] }]);
    const events = await collect(stream({ attempts: [primary], record, firstEventTimeoutMs: 1_000 }));
    expect(events).toEqual([DONE]);
    expect(primary.opens()).toBe(2);
    expect(record.retries).toEqual([expect.objectContaining({ attempt: 1, reason: expect.stringContaining('no event within 1000 ms'), error: expect.objectContaining({ details: expect.objectContaining({ retryable: true, timeout: true }) }) })]);
    expect(timerSignal?.aborted).toBe(true);
  });

  it('uses the policy firstEventTimeoutMs when none is passed', async () => {
    const primary = scripted('a:m', [{ kind: 'hang' }]);
    const policy = { ...NO_JITTER, maxRetries: 0, firstEventTimeoutMs: 50 };
    await expect(collect(stream({ attempts: [primary], policy }))).rejects.toMatchObject({ code: 'provider_failed', details: { timeout: true } });
  });

  it('settles promptly as aborted when aborted during the backoff sleep, opening nothing more', async () => {
    const controller = new AbortController();
    const record = recorder({ isHanging: true });
    const primary = scripted('a:m', [{ kind: 'fail', error: retryable() }, { kind: 'events', events: [DONE] }]);
    const backup = scripted('b:m', [{ kind: 'events', events: [DONE] }]);
    const consumed = collect(stream({ attempts: [primary, backup], record, signal: controller.signal }));
    await settle();
    expect(record.delays).toEqual([500]);
    controller.abort();
    await expect(consumed).rejects.toMatchObject({ code: 'aborted' });
    expect(primary.opens()).toBe(1);
    expect(backup.opens()).toBe(0);
  });

  it('settles as aborted when aborted mid-open, even if the stream ignores its signal, and asks it to return', async () => {
    const controller = new AbortController();
    const stubborn: ScriptedAttempt = (() => {
      let returns = 0;
      const attempt: ProviderAttempt = {
        label: 'a:m',
        open: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<ProviderEvent>>(() => undefined), return: async () => { returns += 1; return { done: true, value: undefined }; } }) }),
      };
      return { attempt, opens: () => 1, returns: () => returns };
    })();
    const consumed = collect(stream({ attempts: [stubborn], signal: controller.signal }));
    await settle();
    controller.abort();
    await expect(consumed).rejects.toMatchObject({ code: 'aborted' });
    await settle();
    expect(stubborn.returns()).toBe(1);
  });

  it('throws aborted without opening anything when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const primary = scripted('a:m', [{ kind: 'events', events: [DONE] }]);
    await expect(collect(stream({ attempts: [primary], signal: controller.signal }))).rejects.toMatchObject({ code: 'aborted' });
    expect(primary.opens()).toBe(0);
  });

  it('calls return() on the inner stream when the consumer abandons it', async () => {
    const primary = scripted('a:m', [{ kind: 'events', events: [TEXT, TEXT, DONE] }]);
    for await (const _event of stream({ attempts: [primary] })) break;
    await settle();
    expect(primary.returns()).toBe(1);
  });

  it('property: opens are bounded by (maxRetries + 1) x attempts and consumer-visible events never repeat', async () => {
    const failureArb = fc.oneof(fc.constant('retryable' as const), fc.constant('fatal' as const));
    const scriptArb = fc.array(failureArb, { maxLength: 6 });
    await fc.assert(fc.asyncProperty(fc.array(scriptArb, { minLength: 1, maxLength: 3 }), fc.nat({ max: 3 }), fc.boolean(), async (failureLists, maxRetries, fallbackOnNonRetryable) => {
      const attempts = failureLists.map((failures, attemptIndex) => {
        const scripts: OpenScript[] = failures.map(kind => ({ kind: 'fail', error: kind === 'retryable' ? retryable() : fatal() }));
        const events: ProviderEvent[] = [{ type: 'text-delta', text: `from-${attemptIndex}-a` }, { type: 'text-delta', text: `from-${attemptIndex}-b` }, DONE];
        return scripted(`p${attemptIndex}:m`, [...scripts, { kind: 'events', events }]);
      });
      const policy = { ...NO_JITTER, maxRetries, fallbackOnNonRetryable };
      const seen: ProviderEvent[] = [];
      try {
        for await (const event of stream({ attempts, policy })) seen.push(event);
      } catch {
        // Running out of attempts is a legitimate outcome; the invariants below must hold either way.
      }
      const totalOpens = attempts.reduce((sum, attempt) => sum + attempt.opens(), 0);
      expect(totalOpens).toBeLessThanOrEqual((maxRetries + 1) * attempts.length);
      const texts = seen.flatMap(event => (event.type === 'text-delta' ? [event.text] : []));
      expect(new Set(texts).size).toBe(texts.length);
      expect(seen.filter(event => event.type === 'done').length).toBeLessThanOrEqual(1);
    }), { numRuns: 200 });
  });
});
