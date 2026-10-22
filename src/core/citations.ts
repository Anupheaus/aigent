import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { AigentEvent } from './aigent-events.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

/** Where cited text sits in its source: character offsets (end exclusive) and 1-based lines. */
export interface CitationSpan {
  start: number;
  end: number;
  startLine?: number;
  endLine?: number;
}

/** A passage the answer relies on, as a tool (the knowledge pack) returned it. */
export interface Citation {
  sourceId: string;
  chunkId: string;
  uri: string;
  span: CitationSpan;
}

/** `[[cite:<chunkId>]]`, with one space before it taken along so the text reads naturally once it is removed. */
const CITE_MARKER = / ?\[\[cite:([A-Za-z0-9_.:-]{1,128})\]\]/g;

/** What `applyCitations` made of an answer. */
export interface CitedAnswer {
  /** The answer with every well-formed marker removed (malformed ones are left as written). */
  answer: string;
  /** The cited passages tools returned during the run, in order of first citation, each once. */
  citations: Citation[];
  /** Cited ids no tool returned in this run (dropped). */
  unknown: string[];
}

/** Resolves the answer's `[[cite:<chunkId>]]` markers against the citations the run's tools returned. */
export function applyCitations(params: { answer: string; known: ReadonlyMap<string, Citation> }): CitedAnswer {
  const { answer, known } = params;
  const cited = new Map<string, Citation>();
  const unknown = new Set<string>();
  const stripped = answer.replace(CITE_MARKER, (_marker, chunkId: string) => {
    const citation = known.get(chunkId);
    if (citation == null) unknown.add(chunkId);
    else if (!cited.has(chunkId)) cited.set(chunkId, citation);
    return '';
  });
  return { answer: stripped, citations: [...cited.values()], unknown: [...unknown] };
}

/** The final answer with its markers resolved; cited ids no tool returned are dropped with a `warning` event. */
export function resolveCitations(params: { answer: string; known: ReadonlyMap<string, Citation>; emit(event: AigentEvent): void }): { answer: string; citations: Citation[] } {
  const { answer, known, emit } = params;
  if (!answer.includes('[[cite:')) return { answer, citations: [] };
  const cited = applyCitations({ answer, known });
  if (cited.unknown.length > 0) emit({ type: 'warning', message: `The answer cites chunk ids no tool returned in this run, so they were dropped: ${cited.unknown.join(', ')}` });
  return { answer: cited.answer, citations: cited.citations };
}

/** Adds the citations each successful call's tool reports for its (model-visible) result. */
export function collectCitations(params: { executed: ExecutedToolCall[]; registry: ToolRegistry; into: Map<string, Citation> }): void {
  const { executed, registry, into } = params;
  for (const { envelope } of executed) {
    if (!envelope.ok) continue;
    const citations = registry.get(envelope.tool)?.citations?.(envelope.result) ?? [];
    for (const citation of citations) if (!into.has(citation.chunkId)) into.set(citation.chunkId, citation);
  }
}
