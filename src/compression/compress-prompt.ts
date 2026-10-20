import type { PromptPersona } from '../core/system-prompt.js';
import type { TaskInput } from '../core/task-input.js';
import { estimateTokens } from '../telemetry/estimate-tokens.js';
import { compressText } from './compress-text.js';
import type { CompressionCache } from './compression-cache.js';
import { isFieldCompressed } from './compression-options.js';
import type { ResolvedCompression } from './compression-options.js';
import type { CompressedText, CompressionField, CompressionRecord, PromptPreviewField } from './compressor-types.js';

/** What compressing a prompt needs; absent `compression` means nothing is compressed. */
export interface PromptCompressionContext {
  compression?: ResolvedCompression;
  cache: CompressionCache;
  now(): number;
  /** Ends a compressor call early (the run was stopped); the compression then rejects as aborted. */
  signal?: AbortSignal;
}

/** One field as written and as sent; `result` is set when the field went through the compressor (or its cache). */
export interface FieldOutcome {
  field: CompressionField;
  original: string;
  final: string;
  result?: CompressedText;
}

export interface CompressedPart<T> {
  value: T;
  fields: FieldOutcome[];
}

async function compressField(params: { field: CompressionField; text: string; context: PromptCompressionContext }): Promise<FieldOutcome> {
  const { field, text, context: { compression, cache, now, signal } } = params;
  if (compression == null || !isFieldCompressed({ compression, field })) return { field, original: text, final: text };
  const result = await compressText({ text, field, compression, cache, now, ...(signal == null ? {} : { signal }) });
  return { field, original: text, final: result.text, result };
}

/** The agent's persona, skillset and context, each compressed when its field is on. */
export async function compressPersona(params: { persona: PromptPersona; context: PromptCompressionContext }): Promise<CompressedPart<PromptPersona>> {
  const { persona, context } = params;
  const entries = (['persona', 'skillset', 'context'] as const).filter(field => persona[field] != null && persona[field] !== '');
  const fields = await Promise.all(entries.map(field => compressField({ field, text: persona[field] ?? '', context })));
  const value = fields.reduce<PromptPersona>((compressed, { field, final }) => ({ ...compressed, [field]: final }), { ...persona });
  return { value, fields };
}

/**
 * The task's free text compressed when its field is on: `task`, `context` and each reference's content. Lists
 * (scope, constraints, acceptance criteria) stay verbatim: they are short and every word of them is an instruction.
 */
export async function compressTaskInput(params: { input: TaskInput; context: PromptCompressionContext }): Promise<CompressedPart<TaskInput>> {
  const { input, context } = params;
  const { task, context: taskContext, references = [] } = input;
  const taskField = await compressField({ field: 'task', text: task, context });
  const contextField = taskContext == null ? undefined : await compressField({ field: 'context', text: taskContext, context });
  const referenceFields = await Promise.all(references.map(({ content }) => (content == null ? undefined : compressField({ field: 'references', text: content, context }))));
  const value: TaskInput = {
    ...input,
    task: taskField.final,
    ...(contextField == null ? {} : { context: contextField.final }),
    ...(input.references == null ? {} : { references: references.map((reference, index) => { const field = referenceFields[index]; return field == null ? reference : { ...reference, content: field.final }; }) }),
  };
  const fields = [taskField, contextField, ...referenceFields].filter((field): field is FieldOutcome => field != null);
  return { value, fields };
}

/** Telemetry for the fields that went through the compressor or its cache (text under `minTokens` is not recorded). */
export function compressionRecords(fields: readonly FieldOutcome[]): CompressionRecord[] {
  return fields.flatMap(({ field, result }) => {
    if (result == null || result.isSkipped) return [];
    const { originalTokens, compressedTokens, ratio, latencyMs, cacheHit } = result;
    return [{ field, originalTokens, compressedTokens, ratio, latencyMs, cacheHit }];
  });
}

/** The preview rows for fields. */
export function previewFields(fields: readonly FieldOutcome[]): PromptPreviewField[] {
  return fields.map(({ field, original, final }) => ({ field, original, final, originalTokens: estimateTokens(original), finalTokens: estimateTokens(final), compressed: final !== original }));
}

/** Warnings for rejected or failed compressions. */
export function compressionWarnings(fields: readonly FieldOutcome[]): string[] {
  return fields.flatMap(({ result }) => (result?.warning == null ? [] : [result.warning]));
}
