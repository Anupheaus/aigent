import type { ToolCall } from '../providers/provider-types.js';
import type { ExecutedToolCall, ShapeResult } from './execute-tool-call.js';
import type { ToolErrorDetail } from './tool-error-detail.js';
import type { Tool } from './tool-types.js';
import { truncateResult } from './truncate-result.js';

interface FailedCallParams {
  call: ToolCall;
  error: ToolErrorDetail;
  durationMs: number;
}

interface SucceededCallParams {
  call: ToolCall;
  tool: Tool;
  result: unknown;
  durationMs: number;
  shape?: ShapeResult;
}

/** A failed call's result: the whole error, never truncated. */
export function failedCall(params: FailedCallParams): ExecutedToolCall {
  const { call, error, durationMs } = params;
  // Failures are never truncated: the model needs the whole error to recover.
  const { size } = truncateResult({ result: error });
  return {
    envelope: { id: call.id, tool: call.name, ok: false, error },
    outcome: { success: false, reason: error.message },
    durationMs,
    size,
    nested: [],
  };
}

/**
 * Everything telemetry and error reporting need is taken from the full result; the model sees its shaped form,
 * truncated to the tool's budget.
 */
export function succeededCall(params: SucceededCallParams): ExecutedToolCall {
  const { call, tool, result, durationMs, shape } = params;
  const { size } = truncateResult({ result });
  const shapedValue = shape?.({ tool, callId: call.id, value: result }) ?? { value: result, shaped: [] };
  const { result: visible, size: { truncated } } = truncateResult({ result: shapedValue.value, maxResultTokens: tool.maxResultTokens });
  const items = tool.countItems?.(result);
  const planned = tool.plannedEffects?.(result) ?? [];
  const inner = tool.capturedEffects?.(result) ?? [];
  return {
    envelope: { id: call.id, tool: call.name, ok: true, result: visible },
    outcome: tool.summarise?.(result) ?? { success: true, reason: 'completed' },
    durationMs,
    size: { ...size, truncated },
    nested: tool.nestedFailures?.(result) ?? [],
    ...(items == null ? {} : { items }),
    ...(shapedValue.shaped.length === 0 ? {} : { shaped: shapedValue.shaped }),
    ...(planned.length === 0 ? {} : { plannedEffects: planned }),
    ...(inner.length === 0 ? {} : { effects: inner }),
  };
}
