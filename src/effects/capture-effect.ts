import type { Tool, ToolContext } from '../tools/tool-types.js';
import type { CapturedEffect, UndoDescriptor } from './undo-types.js';

function isPlainJson(value: unknown): value is UndoDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    // Cycles or BigInts: such a descriptor could never be stored, so the effect is recorded as not undoable.
    return false;
  }
}

/**
 * Right after a successful call of a tool with side effects: the tool's undo descriptor (plain JSON) when it declares
 * `undo`, else an effect that cannot be undone. A throwing or invalid `undo` never fails the call itself.
 */
export async function captureEffect(params: { tool: Tool; args: unknown; result: unknown; context: ToolContext }): Promise<CapturedEffect> {
  const { tool, args, result, context } = params;
  const base = { callId: context.callId, tool: tool.name };
  if (tool.undo == null) return { ...base, message: `Tool '${tool.name}' records no undo data, so its effect cannot be undone` };
  try {
    const descriptor = await tool.undo(args, result, context);
    if (descriptor === undefined) return { ...base, message: `Tool '${tool.name}' gave no undo data for this call, so it cannot be undone` };
    if (!isPlainJson(descriptor)) return { ...base, message: `Tool '${tool.name}' gave undo data that is not a plain JSON object, so this call cannot be undone` };
    return { ...base, descriptor: structuredClone(descriptor) };
  } catch (error) {
    return { ...base, message: `Capturing undo data for tool '${tool.name}' failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
