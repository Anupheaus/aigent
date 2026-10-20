import { describeError } from '../core/describe-value.js';
import { raceSignal } from '../core/race-signal.js';
import type { Tool, ToolActivityView, ToolOutcome } from './tool-types.js';

export type ToolActivityEmission =
  | { type: 'tool-activity'; callId: string; view: ToolActivityView }
  | { type: 'warning'; message: string };

export interface StartToolActivityParams {
  tool: Tool;
  args: unknown;
  callId: string;
  outcome: Promise<ToolOutcome>;
  /** Aborts when the run no longer wants activity updates; rendering stops and nothing more is emitted. */
  signal: AbortSignal;
  emit(event: ToolActivityEmission): void;
}

interface EmitViewsParams {
  views: AsyncIterable<ToolActivityView>;
  callId: string;
  signal: AbortSignal;
  emit(event: ToolActivityEmission): void;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ToolActivityView> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/** Asks an abandoned renderer to finish. Not awaited: a generator suspended mid-await only completes `return()` after that await settles. */
function stopIterator(iterator: AsyncIterator<ToolActivityView>): void {
  Promise.resolve()
    .then(() => iterator.return?.())
    .catch(() => undefined); // the renderer is being abandoned; its clean-up errors have nowhere useful to go
}

async function emitViews(params: EmitViewsParams): Promise<void> {
  const { views, callId, signal, emit } = params;
  const iterator = views[Symbol.asyncIterator]();
  for (;;) {
    const raced = await raceSignal({ work: iterator.next(), signal });
    if (raced.isAborted) { stopIterator(iterator); return; }
    const { done, value } = raced.value;
    if (done === true) return;
    emit({ type: 'tool-activity', callId, view: value });
  }
}

/** Runs the tool's presentation-only renderer. Never rejects: a broken or never-settling renderer must not affect the run. */
export async function startToolActivity(params: StartToolActivityParams): Promise<void> {
  const { tool, args, callId, outcome, signal, emit } = params;
  try {
    const rendered = tool.describeActivity(args, outcome);
    if (isAsyncIterable(rendered)) {
      await emitViews({ views: rendered, callId, signal, emit });
      return;
    }
    const raced = await raceSignal({ work: Promise.resolve(rendered), signal });
    if (raced.isAborted) return;
    emit({ type: 'tool-activity', callId, view: raced.value });
  } catch (error) { // renderer is consumer code; contain its failures
    if (signal.aborted) return;
    emit({ type: 'warning', message: `describeActivity for tool '${tool.name}' failed: ${describeError(error)}` });
    emit({ type: 'tool-activity', callId, view: { title: tool.name } });
  }
}
