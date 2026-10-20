import type { VolatileSection } from '../context/volatile-block.js';
import { runTool } from '../tools/run-tool.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import type { Tool, ToolContext } from '../tools/tool-types.js';
import { toSimulated } from './planned-effects.js';
import type { SimulatedResult } from './planned-effects.js';

/** The error code of a mutating call refused in a dry run because its tool cannot simulate it. */
export const DRY_RUN_UNSUPPORTED_CODE = 'dry_run_unsupported';

/** The volatile-block section that tells the model a run is a dry run. */
export const DRY_RUN_SECTION: VolatileSection = {
  title: 'Dry run',
  body: 'This is a dry run: results of tools with side effects are simulated and nothing is changed. Work as if they happened, and say what would be done.',
};

/** Fail closed: a mutating tool without `dryRun` is never run in a dry run. */
export function dryRunUnsupported(tool: string): ToolErrorDetail {
  return {
    category: 'denied', code: DRY_RUN_UNSUPPORTED_CODE, retryable: false,
    message: `Tool '${tool}' changes things and cannot simulate itself, so it was not run in this dry run`,
    suggestion: 'Describe what this call would do instead of calling it.',
  };
}

export type SimulatedCall = { ok: true; simulated: SimulatedResult } | { ok: false; error: ToolErrorDetail };

/** Runs the tool's `dryRun` within its timeout and the run's signal, and validates the plan it returns. */
export async function simulateCall(params: { tool: Tool; args: unknown; context: ToolContext }): Promise<SimulatedCall> {
  const { tool, args, context } = params;
  const { dryRun } = tool;
  if (dryRun == null) return { ok: false, error: dryRunUnsupported(tool.name) };
  const outcome = await runTool({ tool: { ...tool, run: (simulatedArgs, simulatedContext) => dryRun(simulatedArgs, simulatedContext) }, args, context });
  if (!outcome.ok) return outcome;
  const planned = toSimulated({ output: outcome.result, tool: tool.name, callId: context.callId });
  return planned.ok ? planned : { ok: false, error: { category: 'thrown', code: 'invalid_dry_run', retryable: false, message: planned.error } };
}
