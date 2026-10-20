import type { ResolvedCompression } from '../compression/compression-options.js';
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
  /** The run's current registry (the agent's tools, plus `result_original` once originals can exist). */
  registry(): ToolRegistry;
  /** The kept originals and whether `result_original` is registered, for checkpoints. */
  snapshot(): OriginalsSnapshot;
}

/** A run's originals as a checkpoint stores them. */
export interface OriginalsSnapshot {
  originals: [string, string][];
  hasResultOriginal: boolean;
}

export interface CreateRunOriginalsParams {
  /** The run's registry before any original is kept. */
  registry: ToolRegistry;
  /** With shaping, its store (and its already registered `result_original`) is shared, so handles never collide. */
  shaping?: RunShaping;
  /** Adds `previous` to `result_original` like every other work tool. */
  isFeedbackEnabled: boolean;
  /** The agent's compression; when it compresses tool results, `result_original` is registered from the start. */
  compression?: ResolvedCompression;
  /** A resumed run's originals: kept again, with `result_original` registered when it was. */
  restored?: OriginalsSnapshot;
}

/** Compressed results keep originals on any turn, so their tool must be in the very first request's tool list. */
function compressesToolResults(params: { registry: ToolRegistry; compression?: ResolvedCompression }): boolean {
  const { registry, compression } = params;
  return compression != null && compression.applyTo.includes('toolResults') && registry.list().some(({ compressible }) => compressible != null && compressible !== false);
}

/**
 * Otherwise `result_original` is added only when the first original is kept, by the first compaction stub: a
 * compaction changes the prompt prefix anyway, so the tool list changes only where the prefix already does.
 */
export function createRunOriginals(params: CreateRunOriginalsParams): RunOriginals {
  const { shaping, isFeedbackEnabled, restored } = params;
  let current = params.registry;
  if (shaping != null) {
    shaping.state.originals.restore(restored?.originals ?? []);
    const { originals } = shaping.state;
    return { keep: text => originals.put(text), registry: () => current, snapshot: () => ({ originals: originals.entries(), hasResultOriginal: true }) };
  }
  let store: OriginalStore | undefined;
  const register = (): OriginalStore => {
    const originals = createOriginalStore();
    const tool = createResultOriginalTool({ originals });
    current = createToolRegistry([...current.list(), isFeedbackEnabled ? withFeedbackFields(tool) : tool]);
    return originals;
  };
  if (compressesToolResults(params) || restored?.hasResultOriginal === true) store = register();
  store?.restore(restored?.originals ?? []);
  return {
    keep: text => {
      store ??= register();
      return store.put(text);
    },
    registry: () => current,
    snapshot: () => ({ originals: store?.entries() ?? [], hasResultOriginal: store != null }),
  };
}
