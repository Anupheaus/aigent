import { createAigentError } from '../core/aigent-error.js';
import type { CompressionField, CompressionOptions, CompressionTarget, Compressor } from './compressor-types.js';

export const DEFAULT_TARGET_RATIO = 0.5;
export const DEFAULT_MIN_TOKENS = 200;
const COMPRESSION_TARGETS: readonly CompressionTarget[] = ['toolResults', 'history', 'retrieval'];
const STATIC_FIELDS = ['persona', 'skillset', 'context', 'task', 'references', 'examples'] as const;

/** A static field that `fields` can switch. */
export type StaticCompressionField = typeof STATIC_FIELDS[number];

/** `persona` and `skillset` are instructions in their purest form: off until an eval shows compressing them is safe. */
const DEFAULT_FIELDS: Readonly<Record<StaticCompressionField, boolean>> = { persona: false, skillset: false, context: true, task: true, references: true, examples: true };

/** Compression settings with every default filled in. */
export interface ResolvedCompression {
  compressor: Compressor;
  targetRatio: number;
  minTokens: number;
  fields: Record<StaticCompressionField, boolean>;
  applyTo: CompressionTarget[];
  forceKeep: string[];
}

function invalid(params: { agentName: string; problem: string }): Error {
  const { agentName, problem } = params;
  return createAigentError({ code: 'invalid_definition', message: `Agent '${agentName}' has invalid compression options: ${problem}`, details: { agentName } });
}

function checkCompressor(params: { agentName: string; compressor: unknown }): Compressor {
  const { agentName, compressor } = params;
  const candidate = compressor as Partial<Compressor> | undefined;
  const isValid = candidate != null && typeof candidate.id === 'string' && candidate.id !== '' && typeof candidate.version === 'string' && candidate.version !== '' && typeof candidate.compress === 'function';
  if (!isValid) throw invalid({ agentName, problem: 'compressor must have a non-empty id and version and a compress function' });
  return candidate as Compressor;
}

/** Validates `compression` and fills the defaults; throws `invalid_definition` naming the problem. */
export function parseCompressionOptions(params: { agentName: string; options: CompressionOptions | undefined }): ResolvedCompression | undefined {
  const { agentName, options } = params;
  if (options == null) return undefined;
  const { targetRatio = DEFAULT_TARGET_RATIO, minTokens = DEFAULT_MIN_TOKENS, fields = {}, applyTo = ['toolResults'], forceKeep = [] } = options;
  const compressor = checkCompressor({ agentName, compressor: options.compressor });
  if (!(targetRatio > 0 && targetRatio < 1)) throw invalid({ agentName, problem: `targetRatio must be between 0 and 1 (exclusive), got ${targetRatio}` });
  if (!Number.isSafeInteger(minTokens) || minTokens < 0) throw invalid({ agentName, problem: `minTokens must be a non-negative integer, got ${minTokens}` });
  const unknownField = Object.keys(fields).find(field => !(STATIC_FIELDS as readonly string[]).includes(field));
  if (unknownField != null) throw invalid({ agentName, problem: `unknown field '${unknownField}'; expected one of ${STATIC_FIELDS.join(', ')}` });
  const unknownTarget = applyTo.find(target => !COMPRESSION_TARGETS.includes(target));
  if (unknownTarget != null) throw invalid({ agentName, problem: `unknown applyTo '${String(unknownTarget)}'; expected ${COMPRESSION_TARGETS.join(', ')}` });
  if (forceKeep.some(entry => typeof entry !== 'string' || entry === '')) throw invalid({ agentName, problem: 'forceKeep entries must be non-empty strings' });
  return { compressor, targetRatio, minTokens, fields: { ...DEFAULT_FIELDS, ...fields }, applyTo: [...applyTo], forceKeep: [...forceKeep] };
}

/** Whether a static field is compressed under these settings. */
export function isFieldCompressed(params: { compression: ResolvedCompression; field: CompressionField }): boolean {
  const { compression: { fields }, field } = params;
  return field !== 'toolResult' && fields[field];
}

/** What the agent version hashes: everything that changes compressed output, the compressor by id and version. */
export function compressionVersionInput(compression: ResolvedCompression): Record<string, unknown> {
  const { compressor: { id, version }, targetRatio, minTokens, fields, applyTo, forceKeep } = compression;
  return { compressor: { id, version }, targetRatio, minTokens, fields, applyTo, forceKeep };
}
