import { Worker } from 'node:worker_threads';

/**
 * Wall time is the one budget not derived from a deterministic measurement: the same run takes longer on a slower or
 * busier machine. The bench's own tests therefore judge a run's wall time against its declared budget scaled by how
 * slow the machine is right now, measured with a fixed calibration workload run next to the run being judged. Counts
 * (tokens, turns, tool calls) are judged exactly; only time is scaled, and never by more than `MAX_SLOWDOWN`, so a
 * genuinely slow policy still fails.
 */

/** What the calibration workload takes on an idle development machine (median of runs, Windows 11, Node 24). */
export const CALIBRATION_BASELINE_MS = 22;
/** The most a machine is allowed to be slower than the baseline; past it time checks fail rather than stretch further. */
export const MAX_SLOWDOWN = 8;
/** Characters of synthetic source the workload scans: about the text of a small repository. */
const WORKLOAD_CHARS = 400_000;
/** Event-loop hops in the workload: bench runs are many small awaited steps, not one long computation. */
const WORKLOAD_HOPS = 50;
const WORKLOAD_PATTERN = /\bexport\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/g;
const WORKER_SOURCE = "const { parentPort } = require('node:worker_threads'); parentPort.postMessage('ready');";

const hop = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

/** Starts a worker thread and waits for its first message: the search tools run their regexes in worker threads. */
function startWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.once('message', () => { void worker.terminate().then(() => resolve(), reject); });
    worker.once('error', reject);
  });
}

/** The fixed workload: text building and regex scanning split over event-loop hops, plus one worker start. */
async function runWorkload(): Promise<number> {
  let found = 0;
  const line = 'export const someName = 1;\nconst other = someName + 2;\n';
  const text = line.repeat(Math.ceil(WORKLOAD_CHARS / line.length));
  const slice = Math.ceil(text.length / WORKLOAD_HOPS);
  for (let offset = 0; offset < text.length; offset += slice) {
    found += [...text.slice(offset, offset + slice).matchAll(WORKLOAD_PATTERN)].length;
    await hop();
  }
  await startWorker();
  return found;
}

/** How much slower than the baseline a calibration time is, between 1 (never faster than idle) and `MAX_SLOWDOWN`. */
export function slowdownFrom(params: { measuredMs: number; baselineMs?: number }): number {
  const { measuredMs, baselineMs = CALIBRATION_BASELINE_MS } = params;
  return Math.min(MAX_SLOWDOWN, Math.max(1, measuredMs / baselineMs));
}

/** Times one calibration workload now and returns the machine's slowdown. */
export async function measureSlowdown(): Promise<number> {
  const started = performance.now();
  await runWorkload();
  return slowdownFrom({ measuredMs: performance.now() - started });
}

/** A value and the machine's slowdown around producing it (the larger of the calibrations before and after). */
export interface Timed<T> {
  value: T;
  slowdown: number;
}

/** Runs `run` between two calibrations, so load that comes or goes during the run is seen by one of them. */
export async function withSlowdown<T>(run: () => Promise<T>): Promise<Timed<T>> {
  const before = await measureSlowdown();
  const value = await run();
  const after = await measureSlowdown();
  return { value, slowdown: Math.max(before, after) };
}

/** A run's wall time against a declared limit on this machine. */
export interface WallTimeCheck {
  label: string;
  ms: number;
  maxMs: number;
  slowdown: number;
}

/** Whether `ms` is within `maxMs` scaled by the machine's slowdown. */
export const isWithinWallTime = (check: Omit<WallTimeCheck, 'label'>): boolean => check.ms <= check.maxMs * check.slowdown;

/** A finding when the run took longer than its declared time allows on this machine; none otherwise. */
export function wallTimeFindings(check: WallTimeCheck): string[] {
  const { label, ms, maxMs, slowdown } = check;
  if (isWithinWallTime(check)) return [];
  return [`${label} took ${ms} ms, over the declared ${maxMs} ms x machine slowdown ${slowdown.toFixed(2)} = ${Math.round(maxMs * slowdown)} ms`];
}
