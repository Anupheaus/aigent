import type { ProviderToolSpec } from '../providers/provider-types.js';

/** What a compressor is asked to do. */
export interface CompressorInput {
  text: string;
  /** Share of the text to keep, e.g. 0.5 keeps about half. */
  targetRatio: number;
  /** Exact substrings that must appear unchanged in the output (protected spans and `forceKeep`). */
  protect: string[];
  signal?: AbortSignal;
}

/**
 * A pluggable prompt compressor (e.g. an LLMLingua-2 adapter). It must be deterministic: the same text, ratio and
 * protect list give byte-identical output for the same `id` and `version`, because results are cached by them.
 */
export interface Compressor {
  /** Stable name, part of the cache key and the agent version. */
  id: string;
  /** Bump whenever the output for the same input could change (model, weights, algorithm). */
  version: string;
  compress(input: CompressorInput): Promise<{ text: string }>;
}

/** Content that can be compressed. */
export type CompressionField = 'persona' | 'skillset' | 'context' | 'task' | 'references' | 'examples' | 'toolResult';

/** Dynamic content compressed when it is committed to history. Only `toolResults` is produced by the library today. */
export type CompressionTarget = 'toolResults' | 'history' | 'retrieval';

/** `ai.agent({ compression })`. */
export interface CompressionOptions {
  compressor: Compressor;
  /** Share of the text to keep (default 0.5). */
  targetRatio?: number;
  /** Texts shorter than this many estimated tokens are left alone (default 200). */
  minTokens?: number;
  /** Which static fields are compressed: `persona` and `skillset` default off, the others on. */
  fields?: { persona?: boolean; skillset?: boolean; context?: boolean; task?: boolean; references?: boolean; examples?: boolean };
  /** Dynamic content to compress (default `['toolResults']`, which still needs the tool's `compressible`). */
  applyTo?: CompressionTarget[];
  /** Extra exact substrings that must survive every compression (identifiers, product names...). */
  forceKeep?: string[];
  /**
   * Milliseconds one compressor call may take (default 30,000). A call that does not answer in time is told to stop
   * through its `signal`, and the original text is used with a warning; the failure is not cached.
   */
  timeoutMs?: number;
}

/** One compression a run used, as stored on its run record. */
export interface CompressionRecord {
  field: CompressionField;
  originalTokens: number;
  compressedTokens: number;
  /** `compressedTokens / originalTokens` (1 when nothing changed). */
  ratio: number;
  /** Time the compressor took; 0 on a cache hit. */
  latencyMs: number;
  cacheHit: boolean;
}

/** The outcome of compressing one text. */
export interface CompressedText {
  /** What the model sees: the compressed text, or the original when compression was skipped or rejected. */
  text: string;
  originalText: string;
  originalTokens: number;
  compressedTokens: number;
  ratio: number;
  cacheHit: boolean;
  /** sha-256 cache key over source, compressor id and version, and parameters. */
  key: string;
  latencyMs: number;
  /** The text was under `minTokens`, so the compressor was not asked at all. */
  isSkipped: boolean;
  /** Set when the compressor's output was rejected (dropped protected content, or failed). */
  warning?: string;
  /** The compressor threw or timed out: nothing was cached, so a later call tries again. */
  isFailed: boolean;
}

/** One field of a preview: what was written and what the model sees. */
export interface PromptPreviewField {
  field: CompressionField;
  original: string;
  final: string;
  originalTokens: number;
  finalTokens: number;
  compressed: boolean;
}

/** `agent.preview(input?)`: the exact prompt a task would start with, without calling a provider. */
export interface PromptPreview {
  system: string;
  /** The task brief (empty without an input). */
  brief: string;
  tools: ProviderToolSpec[];
  fields: PromptPreviewField[];
  /** Estimated tokens of the system prompt, brief and tool specs. */
  totalTokens: number;
}
