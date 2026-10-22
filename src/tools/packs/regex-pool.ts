import { Worker } from 'node:worker_threads';
import { REGEX_WORKER_SOURCE } from './regex-worker-source.js';

/** Most regex workers alive at once; further jobs wait for one. */
export const MAX_REGEX_WORKERS = 2;
/** An idle worker is terminated after this long, so a quiet process holds none. */
const IDLE_WORKER_MS = 10_000;
/** A worker's heap cap: a pattern that builds huge match lists dies instead of exhausting the host. */
const WORKER_HEAP_MB = 64;

/** What one job asks the worker to do (see `REGEX_WORKER_SOURCE`). */
export interface RegexJob {
  pattern: string;
  flags: string;
  texts: string[];
  /** Matches to return in full. */
  keep: number;
  /** Keep counting past `keep` (false: stop at `keep`, with `isComplete: false`). */
  countAll: boolean;
  /** Only whether each text matches: each text's first match counts, an empty one included. */
  firstPerText?: boolean;
}

/** One match, with the index of the text it was found in. */
export interface RegexMatch {
  text: number;
  index: number;
  match: string;
  captures: (string | null)[];
  groups: Record<string, string | null> | null;
}

export type RegexJobOutcome =
  | { status: 'done'; count: number; matches: RegexMatch[]; isComplete: boolean }
  | { status: 'failed'; message: string }
  | { status: 'timed-out' }
  | { status: 'aborted' };

interface PooledWorker {
  worker: Worker;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const idle: PooledWorker[] = [];
const waiting: ((pooled: PooledWorker) => void)[] = [];
let alive = 0;
let nextJobId = 0;

/** Workers alive now (busy or idle), for tests of the pool bound. */
export function regexWorkerCount(): number {
  return alive;
}

function spawn(): PooledWorker {
  alive += 1;
  const worker = new Worker(REGEX_WORKER_SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
  // A pooled worker never keeps the process alive.
  worker.unref();
  return { worker };
}

/** Ends a worker for good (it overran, failed or idled out) and lets a waiting job have a fresh one. */
function discard(pooled: PooledWorker): void {
  if (pooled.idleTimer != null) clearTimeout(pooled.idleTimer);
  alive -= 1;
  void pooled.worker.terminate().catch(() => undefined);
  const next = waiting.shift();
  if (next != null) next(spawn());
}

function release(pooled: PooledWorker): void {
  const next = waiting.shift();
  if (next != null) { next(pooled); return; }
  pooled.idleTimer = setTimeout(() => {
    const at = idle.indexOf(pooled);
    if (at !== -1) idle.splice(at, 1);
    discard(pooled);
  }, IDLE_WORKER_MS);
  pooled.idleTimer.unref();
  idle.push(pooled);
}

function acquire(): Promise<PooledWorker> {
  const ready = idle.pop();
  if (ready != null) {
    if (ready.idleTimer != null) clearTimeout(ready.idleTimer);
    return Promise.resolve(ready);
  }
  if (alive < MAX_REGEX_WORKERS) return Promise.resolve(spawn());
  return new Promise(resolve => { waiting.push(resolve); });
}

/**
 * Runs one job in a pooled worker thread. A job that does not finish by `deadline` (epoch ms, waiting for a worker
 * included) or whose `signal` aborts has its worker terminated, so a catastrophic pattern never blocks this thread.
 */
export async function runRegexJob(params: { job: RegexJob; deadline: number; signal?: AbortSignal }): Promise<RegexJobOutcome> {
  const { job, deadline, signal } = params;
  if (signal?.aborted === true) return { status: 'aborted' };
  const pooled = await acquire();
  // The wait for a worker used up the time: hand it back unused rather than kill a healthy worker.
  if (Date.now() >= deadline) { release(pooled); return { status: 'timed-out' }; }
  const id = (nextJobId += 1);
  return new Promise<RegexJobOutcome>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: RegexJobOutcome, isHealthy: boolean): void => {
      if (timer != null) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pooled.worker.off('message', onMessage);
      pooled.worker.off('error', onError);
      pooled.worker.off('exit', onExit);
      if (isHealthy) release(pooled); else discard(pooled);
      resolve(outcome);
    };
    const onMessage = (reply: { id: number; ok: boolean; message?: string; count?: number; matches?: RegexMatch[]; isComplete?: boolean }): void => {
      if (reply.id !== id) return;
      finish(reply.ok ? { status: 'done', count: reply.count ?? 0, matches: reply.matches ?? [], isComplete: reply.isComplete ?? true } : { status: 'failed', message: reply.message ?? 'unknown error' }, true);
    };
    const onError = (error: Error): void => finish({ status: 'failed', message: error.message }, false);
    const onExit = (): void => finish({ status: 'failed', message: 'the regex worker stopped' }, false);
    const onAbort = (): void => finish({ status: 'aborted' }, false);
    pooled.worker.on('message', onMessage);
    pooled.worker.on('error', onError);
    pooled.worker.on('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish({ status: 'timed-out' }, false), Math.max(0, deadline - Date.now()));
    pooled.worker.postMessage({ id, ...job });
  });
}
