import type { Tool, ToolActivityView, ToolOutcome } from './tool-types.js';

export type ToolActivityEmission =
  | { type: 'tool-activity'; callId: string; view: ToolActivityView }
  | { type: 'warning'; message: string };

export interface StartToolActivityParams {
  tool: Tool;
  args: unknown;
  callId: string;
  outcome: Promise<ToolOutcome>;
  emit(event: ToolActivityEmission): void;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ToolActivityView> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/** Runs the tool's presentation-only renderer. Never rejects: a broken renderer must not affect the run. */
export async function startToolActivity(params: StartToolActivityParams): Promise<void> {
  const { tool, args, callId, outcome, emit } = params;
  try {
    const rendered = tool.describeActivity(args, outcome);
    if (isAsyncIterable(rendered)) {
      for await (const view of rendered) emit({ type: 'tool-activity', callId, view });
      return;
    }
    emit({ type: 'tool-activity', callId, view: await rendered });
  } catch (error) { // renderer is consumer code; contain its failures
    const reason = error instanceof Error ? error.message : String(error);
    emit({ type: 'warning', message: `describeActivity for tool '${tool.name}' failed: ${reason}` });
    emit({ type: 'tool-activity', callId, view: { title: tool.name } });
  }
}
