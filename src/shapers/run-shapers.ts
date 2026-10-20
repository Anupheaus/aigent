import { createHash } from 'node:crypto';
import { canonicalJson } from '../core/canonical-json.js';
import { estimateTokens } from '../telemetry/estimate-tokens.js';
import type { Tool } from '../tools/tool-types.js';
import { createAliasTable } from './alias-table.js';
import type { AliasTable } from './alias-table.js';
import { createOriginalStore } from './original-store.js';
import type { OriginalStore } from './original-store.js';
import type { ShaperRegistry } from './shaper-registry.js';
import type { ShapedStep, Shaper, ShaperContext, ShaperInput, ShaperOutput, ShapersSetting, ShapingNote } from './shaper-types.js';

/** Shortest string the run's alias table aliases. */
const ALIAS_MIN_LENGTH = 24;
const HASH_ALGORITHM = 'sha256';

/** Per-run shaping state: originals by handle, the alias table and the results seen so far (for dedupe). */
export interface ShapingState {
  originals: OriginalStore;
  aliases: AliasTable;
  /** Content hash of each lossy-ok result → the first call that returned it. */
  seen: Map<string, string>;
}

export interface RunShapersParams {
  /** The full result (the cache holds this original, never the shaped value). */
  value: unknown;
  tool: Pick<Tool, 'name' | 'contentKind' | 'fidelity'>;
  callId: string;
  state: ShapingState;
  /** The task's or agent's `shapers`; default every registered shaper. */
  settings?: ShapersSetting;
  registry: ShaperRegistry;
}

/** What the model sees, and what each applied shaper did to the size. */
export interface ShapedResult {
  /** The value itself when nothing applied; otherwise `{ result, shaping }`. */
  value: unknown;
  shaped: ShapedStep[];
}

export function createShapingState(): ShapingState {
  return { originals: createOriginalStore(), aliases: createAliasTable({ minLength: ALIAS_MIN_LENGTH }), seen: new Map() };
}

/** The result as text: itself when it is a string, its JSON otherwise. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch { // a result JSON cannot represent (cycles, BigInt) is never shaped, so this text is only measured
    return String(value);
  }
}

/** Undefined for a value canonical JSON cannot represent (cycles, BigInt): it simply takes no part in dedupe. */
function contentHash(value: unknown): string | undefined {
  try {
    return createHash(HASH_ALGORITHM).update(typeof value === 'string' ? `s:${value}` : `j:${canonicalJson(value)}`).digest('hex');
  } catch { // JSON.stringify throws on BigInt and overflows the stack on cycles
    return undefined;
  }
}

/** A shaper that throws is skipped: shaping only ever shortens what the model sees, so leaving it out is always safe. */
function tryShape(params: { shaper: Shaper; input: ShaperInput }): ShaperOutput | undefined {
  const { shaper, input } = params;
  try {
    return shaper.shape(input) ?? undefined;
  } catch { // see above: the unshaped value is what the model gets
    return undefined;
  }
}

function isAllowed(shaper: Shaper, settings: ShapersSetting | undefined): boolean {
  return settings == null || (settings !== 'off' && settings.allow.includes(shaper.name));
}

/**
 * Runs the shapers that may touch this result. A verbatim (or undeclared) result, shaping turned off, or a kind no
 * shaper declares leaves the value exactly as it was. Each applied shaper adds a note; the verbatim original is kept
 * once per call under a handle shared by its notes.
 */
export function runShapers(params: RunShapersParams): ShapedResult {
  const { value, tool: { name, contentKind, fidelity }, callId, state, settings, registry } = params;
  if (fidelity !== 'lossy-ok' || contentKind == null || settings === 'off') return { value, shaped: [] };
  const shapers = registry.list().filter(shaper => shaper.appliesTo.includes(contentKind) && isAllowed(shaper, settings));
  if (shapers.length === 0) return { value, shaped: [] };
  const hash = contentHash(value);
  const previousIdenticalCall = hash == null ? undefined : state.seen.get(hash);
  if (hash != null && previousIdenticalCall == null) state.seen.set(hash, callId);
  let handle: string | undefined;
  const context: ShaperContext = {
    callId, tool: name, aliases: state.aliases,
    ...(previousIdenticalCall == null ? {} : { previousIdenticalCall }),
    originalHandle: () => { handle ??= state.originals.put(textOf(value)); return handle; },
  };
  let current = value;
  const notes: ShapingNote[] = [];
  const shaped: ShapedStep[] = [];
  for (const shaper of shapers) {
    const text = textOf(current);
    const output = tryShape({ shaper, input: { value: current, kind: contentKind, text, context } });
    if (output == null) continue;
    notes.push({ shaper: shaper.name, note: output.note, handle: context.originalHandle() });
    shaped.push({ shaper: shaper.name, tokensBefore: estimateTokens(text), tokensAfter: estimateTokens(textOf(output.value)) });
    current = output.value;
  }
  if (notes.length === 0) return { value, shaped: [] };
  return { value: { result: current, shaping: notes }, shaped };
}
