import { withFeedbackFields } from '../feedback/with-feedback-fields.js';
import { createResultOriginalTool } from '../shapers/result-original-tool.js';
import { createShapingState, runShapers } from '../shapers/run-shapers.js';
import type { ShapingState } from '../shapers/run-shapers.js';
import { createBuiltinShaperRegistry } from '../shapers/shaper-registry.js';
import type { ShaperRegistry } from '../shapers/shaper-registry.js';
import type { ShapersSetting } from '../shapers/shaper-types.js';
import type { ShapeResult } from '../tools/execute-tool-call.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

/** One run's shaping: its state (originals, aliases, seen results), the effective setting and the shapers. */
export interface RunShaping {
  state: ShapingState;
  settings?: ShapersSetting;
  registry: ShaperRegistry;
}

export interface CreateRunShapingParams {
  /** The agent's registry (built-ins included). */
  registry: ToolRegistry;
  /** The task's `shapers`, else the agent's. */
  settings: ShapersSetting | undefined;
  /** Adds `previous` to `result_original` like every other work tool. */
  isFeedbackEnabled: boolean;
}

export interface RunShapingSetup {
  /** The agent's registry, plus `result_original` when shaping can happen. */
  registry: ToolRegistry;
  /** Absent when no tool is `lossy-ok` or shaping is off, so nothing is ever shaped. */
  shaping?: RunShaping;
}

/** Shaping only exists for a run that can shape something; only then does the model get `result_original`. */
export function setUpRunShaping(params: CreateRunShapingParams): RunShapingSetup {
  const { registry, settings, isFeedbackEnabled } = params;
  const canShape = settings !== 'off' && registry.list().some(({ fidelity }) => fidelity === 'lossy-ok');
  if (!canShape) return { registry };
  const state = createShapingState();
  const resultOriginal = createResultOriginalTool({ originals: state.originals });
  return {
    registry: createToolRegistry([...registry.list(), isFeedbackEnabled ? withFeedbackFields(resultOriginal) : resultOriginal]),
    shaping: { state, registry: createBuiltinShaperRegistry(), ...(settings == null ? {} : { settings }) },
  };
}

/** The executor hook for one run's top-level calls. */
export function shapeWith(shaping: RunShaping): ShapeResult {
  const { state, settings, registry } = shaping;
  return ({ tool, callId, value }) => runShapers({ value, tool, callId, state, registry, ...(settings == null ? {} : { settings }) });
}
