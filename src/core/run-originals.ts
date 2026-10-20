import { withFeedbackFields } from '../feedback/with-feedback-fields.js';
import { createOriginalStore } from '../shapers/original-store.js';
import type { OriginalStore } from '../shapers/original-store.js';
import { createResultOriginalTool } from '../shapers/result-original-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { RunShaping } from './run-shaping.js';

/** Where a run keeps verbatim originals (shaped, stubbed or compressed results) and the registry that can fetch them. */
export interface RunOriginals {
  /** Keeps `text` and returns its `result_original` handle; makes sure the model has `result_original` from now on. */
  keep(text: string): string;
  /** The run's current registry (the agent's tools, plus `result_original` once anything was kept). */
  registry(): ToolRegistry;
}

export interface CreateRunOriginalsParams {
  /** The run's registry before any original is kept. */
  registry: ToolRegistry;
  /** With shaping, its store (and its already registered `result_original`) is shared, so handles never collide. */
  shaping?: RunShaping;
  /** Adds `previous` to `result_original` like every other work tool. */
  isFeedbackEnabled: boolean;
}

/**
 * Runs without shaping get `result_original` only when the first original is kept (the first compaction stub or
 * compressed result). That happens at a compaction or when a result is committed, so the tool list changes only
 * where the prompt prefix changes anyway.
 */
export function createRunOriginals(params: CreateRunOriginalsParams): RunOriginals {
  const { shaping, isFeedbackEnabled } = params;
  let current = params.registry;
  if (shaping != null) return { keep: text => shaping.state.originals.put(text), registry: () => current };
  let store: OriginalStore | undefined;
  return {
    keep: text => {
      if (store == null) {
        const originals = createOriginalStore();
        const tool = createResultOriginalTool({ originals });
        current = createToolRegistry([...current.list(), isFeedbackEnabled ? withFeedbackFields(tool) : tool]);
        store = originals;
      }
      return store.put(text);
    },
    registry: () => current,
  };
}
