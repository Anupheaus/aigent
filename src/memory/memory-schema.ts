import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import { MEMORY_KINDS, MEMORY_SCOPES } from './memory-types.js';
import type { MemoryNote, MemoryOptions, MemoryRetriever, ResolvedMemoryOptions } from './memory-types.js';

/** The argument key that carries memory notes on a tool call. */
export const MEMORY_FIELD = 'memory';
/** Longest note text, in characters. */
export const MAX_MEMORY_TEXT_LENGTH = 300;
/** Most tags on one note. */
export const MAX_MEMORY_TAGS = 5;
/** Longest tag, in characters. */
export const MAX_MEMORY_TAG_LENGTH = 24;

const DEFAULT_MEMORY_OPTIONS: ResolvedMemoryOptions = { scope: 'agent', maxEntries: 200, maxPerCall: 3, halfLifeDays: 30, minConfidence: 0.2, recallLimit: 6 };

const positiveInteger = z.number().int().positive();

const memoryOptionsSchema = z.object({
  scope: z.enum(MEMORY_SCOPES).optional(),
  maxEntries: positiveInteger.optional(),
  maxPerCall: positiveInteger.optional(),
  halfLifeDays: z.number().positive().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  recallLimit: positiveInteger.optional(),
  retriever: z.custom<MemoryRetriever>(value => typeof (value as Partial<MemoryRetriever> | null)?.rank === 'function', 'retriever must have a rank(query, entries) function').optional(),
}).strict();

/**
 * One note as the model sends it: strict decoding sends absent optionals as null. `pinned` is not in the schema the
 * model sees; it is still accepted (and ignored) so a model that sends it anyway loses only the pin, not the note.
 */
const memoryNoteSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  text: z.string().trim().min(1).max(MAX_MEMORY_TEXT_LENGTH),
  tags: z.array(z.string().min(1).max(MAX_MEMORY_TAG_LENGTH)).max(MAX_MEMORY_TAGS).nullish(),
  pinned: z.boolean().nullish(),
}).strict();

export interface ResolveMemoryOptionsParams {
  /** Named in errors, e.g. `createAigent` or `Agent 'helper'`. */
  owner: string;
  options: MemoryOptions | boolean | undefined;
}

/** Memory is opt-in: undefined unless `true` or options are given. Throws `invalid_definition` naming each bad field. */
export function resolveMemoryOptions(params: ResolveMemoryOptionsParams): ResolvedMemoryOptions | undefined {
  const { owner, options } = params;
  if (options == null || options === false) return undefined;
  const result = memoryOptionsSchema.safeParse(options === true ? {} : options);
  if (!result.success) {
    throw createAigentError({ code: 'invalid_definition', message: `${owner} has invalid memory options: ${describeIssues(result.error)}`, details: { issues: result.error.issues.length } });
  }
  const { retriever: _retriever, ...settings } = result.data;
  const defined = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
  return { ...DEFAULT_MEMORY_OPTIONS, ...defined };
}

/** The consumer's retriever, when the options give one (validated by `resolveMemoryOptions`). */
export function retrieverOf(options: MemoryOptions | boolean | undefined): MemoryRetriever | undefined {
  return typeof options === 'object' ? options.retriever : undefined;
}

export interface ParseMemoryNotesParams {
  /** The `memory` field as the model sent it. */
  value: unknown;
  maxPerCall: number;
}

export interface ParsedMemoryNotes {
  notes: MemoryNote[];
  /** One line per note (or group of notes) that was not accepted. */
  problems: string[];
}

function ordinalList(positions: number[]): string {
  if (positions.length === 1) return String(positions[0]);
  return `${positions.slice(0, -1).join(', ')} and ${positions[positions.length - 1]}`;
}

/** Validates each note on its own, so one bad note never costs the others; nothing here throws. */
export function parseMemoryNotes(params: ParseMemoryNotesParams): ParsedMemoryNotes {
  const { value, maxPerCall } = params;
  if (value == null) return { notes: [], problems: [] };
  if (!Array.isArray(value)) return { notes: [], problems: [`${MEMORY_FIELD} must be a list of notes or null; nothing was saved`] };
  const problems: string[] = [];
  if (value.length > maxPerCall) {
    const dropped = value.slice(maxPerCall).map((_note, offset) => maxPerCall + offset + 1);
    problems.push(`${value.length} memory notes sent but at most ${maxPerCall} are accepted per call; notes ${ordinalList(dropped)} were not saved`);
  }
  const notes: MemoryNote[] = [];
  value.slice(0, maxPerCall).forEach((rawNote: unknown, position) => {
    const parsed = memoryNoteSchema.safeParse(rawNote);
    if (!parsed.success) {
      problems.push(`memory note ${position + 1} was not saved: ${describeIssues(parsed.error)}`);
      return;
    }
    const { kind, text, tags, pinned } = parsed.data;
    // A pinned note never fades and outlives every unpinned one: a privilege of the application, never of the model.
    if (pinned === true) problems.push(`memory note ${position + 1} was saved unpinned: only the application can pin a memory`);
    notes.push({ kind, text, ...(tags == null ? {} : { tags }) });
  });
  return { notes, problems };
}
