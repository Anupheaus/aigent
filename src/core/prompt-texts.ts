import { compressionRecords, compressionWarnings, compressTaskInput } from '../compression/compress-prompt.js';
import type { FieldOutcome, PromptCompressionContext } from '../compression/compress-prompt.js';
import type { CompressionRecord } from '../compression/compressor-types.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { StaticPrompt } from './static-prompt.js';
import { buildTaskBrief } from './task-brief.js';
import type { TaskInput } from './task-input.js';

/** The two texts every run starts with, as the model will see them, and how compression shaped them. */
export interface PromptTexts {
  system: string;
  /** The task brief; empty without an input (a preview of the agent alone). */
  brief: string;
  fields: FieldOutcome[];
  records: CompressionRecord[];
  warnings: string[];
}

export interface BuildPromptTextsParams {
  /** The agent's persona, compressed once per agent (memoised by the caller). */
  staticPrompt: StaticPrompt;
  input?: TaskInput;
  /** With `signal` set, compression stops when the run is stopped (rejects as aborted). */
  context: PromptCompressionContext;
}

/**
 * The system prompt and task brief with compression applied: persona fields from the agent's memo, task fields
 * through the store-backed cache. The run and `agent.preview` both use this, so a preview shows exactly what is sent.
 */
export async function buildPromptTexts(params: BuildPromptTextsParams): Promise<PromptTexts> {
  const { staticPrompt, input, context } = params;
  const persona = await staticPrompt(context.signal);
  const task = input == null ? undefined : await compressTaskInput({ input, context });
  const fields = [...persona.fields, ...(task?.fields ?? [])];
  return {
    system: buildSystemPrompt(persona.value),
    brief: task == null ? '' : buildTaskBrief(task.value),
    fields,
    records: compressionRecords(fields),
    warnings: compressionWarnings(fields),
  };
}
