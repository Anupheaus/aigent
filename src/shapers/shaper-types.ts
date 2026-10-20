import type { AliasTable } from './alias-table.js';

/** What a tool result contains; shapers declare which kinds they may touch. */
export const CONTENT_KINDS = ['file-content', 'web-page', 'command-output', 'structured-data', 'search-hits', 'prose', 'log', 'binary-ref'] as const;

export type ContentKind = typeof CONTENT_KINDS[number];

/** `verbatim` (the default) means nothing may alter the result; `lossy-ok` lets shapers whose `appliesTo` includes the kind run. */
export const FIDELITIES = ['verbatim', 'lossy-ok'] as const;

export type Fidelity = typeof FIDELITIES[number];

/** Agent or task control over shaping: off entirely, or only the named shapers. Default: every built-in shaper. */
export type ShapersSetting = 'off' | { allow: string[] };

/** Run state a shaper may read while shaping one result. */
export interface ShaperContext {
  callId: string;
  tool: string;
  /** The call in this run whose result was identical to this one, if any. */
  previousIdenticalCall?: string;
  /** The handle under which this call's verbatim original is kept (allocated on first use). */
  originalHandle(): string;
  /** The run's alias table (aliasing assigns new aliases into it). */
  aliases: AliasTable;
}

export interface ShaperInput {
  /** The result as shaped so far. */
  value: unknown;
  kind: ContentKind;
  /** `value` as text: itself when it is a string, its JSON otherwise. */
  text: string;
  context: ShaperContext;
}

export interface ShaperOutput {
  value: unknown;
  /** Visible marker for the model, e.g. `HTML boilerplate removed; full page: handle H7`. */
  note: string;
}

/** A pure result transformation, run only for `lossy-ok` results of a kind it declares in `appliesTo`. */
export interface Shaper {
  /** Unique, used in `shapers: { allow }` and in traces. */
  name: string;
  /** The only kinds it may touch; required and non-empty. */
  appliesTo: ContentKind[];
  /** The shaped result, or undefined when there is nothing to change. */
  shape(input: ShaperInput): ShaperOutput | undefined;
}

/** One shaper's mark on a result the model sees. */
export interface ShapingNote {
  shaper: string;
  note: string;
  /** Pass to `result_original` for the verbatim original. */
  handle: string;
}

/** What one shaper did to a result's size, for the trace. */
export interface ShapedStep {
  shaper: string;
  tokensBefore: number;
  tokensAfter: number;
}
