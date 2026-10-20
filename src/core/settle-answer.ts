import { OUTPUT_INVALID_CODE, parseStructuredOutput } from '../guardrails/builtin/output-schema.js';
import type { GuardrailRunContext } from '../guardrails/guardrail-types.js';
import type { AigentEvent } from './aigent-events.js';
import type { AnswerVerdict, RunGuardrails, StructureVerdict } from './run-guardrails.js';

/** The final answer after the output guardrails: kept (maybe rewritten), to be retried, or failed. */
export type SettledAnswer =
  | { kind: 'answer'; answer: string; output?: unknown }
  | { kind: 'retry'; feedback: string }
  | { kind: 'failed'; answer: string; failure: string };

export interface SettleAnswerParams {
  /** The final answer as the model wrote it. */
  text: string;
  /** What the turn streamed of it (after the stream guardrails); withdrawn when the settled answer differs. */
  streamed?: string;
  guardrails?: RunGuardrails;
  /** The task's structured output, when it has one. */
  structured: GuardrailRunContext;
  /** Turns left to fix an answer that fails the `output` schema (bounded by the run's remaining turns). */
  retriesLeft: number;
  emit(event: AigentEvent): void;
}

const VALID: StructureVerdict = { ok: true };

function withheld(verdict: Extract<AnswerVerdict, { blocked: unknown }>): string {
  const { blocked: { guardrail, reason } } = verdict;
  return `[answer withheld by guardrail '${guardrail}': ${reason}]`;
}

/**
 * Checks the model's final text. The task's `output` schema is checked against the text as written (an answer failing
 * it is sent back with the issues while retries are left, then fails the run with `output_invalid`); the other output
 * guardrails then rewrite it. A blocked answer is withheld, and fails a structured task. A failed run's answer is
 * always the rewritten (redacted) one, never the raw text.
 */
export async function settleAnswer(params: SettleAnswerParams): Promise<SettledAnswer> {
  const { streamed = '', emit } = params;
  const settled = await settle(params);
  if (settled.kind === 'retry') {
    if (streamed !== '') emit({ type: 'text-retracted', text: streamed, reason: 'output_invalid: the answer was sent back to be fixed' });
  } else if (settled.answer !== streamed.trim()) {
    emit({ type: 'text-retracted', text: streamed, replacement: settled.answer, reason: 'the output guardrails changed the answer' });
  }
  return settled;
}

async function settle(params: SettleAnswerParams): Promise<SettledAnswer> {
  const { text, guardrails, structured: { output: schema, outputFormat = 'json' }, retriesLeft, emit } = params;
  const structure = guardrails == null ? VALID : await guardrails.checkStructure(text);
  if (!structure.ok && retriesLeft > 0) return { kind: 'retry', feedback: `Your answer was not accepted: ${structure.reason}. Reply again with only the corrected answer.` };
  const verdict: AnswerVerdict = guardrails == null ? { answer: text } : await guardrails.checkOutput(text);
  const shown = 'blocked' in verdict ? withheld(verdict) : verdict.answer;
  if (!structure.ok) return { kind: 'failed', answer: shown, failure: `${OUTPUT_INVALID_CODE}: ${structure.reason}` };
  if ('blocked' in verdict) {
    const { blocked: { guardrail, code, reason } } = verdict;
    // A structured task's caller needs the output; a withheld answer has none, so the run fails.
    if (schema != null) return { kind: 'failed', answer: shown, failure: `${code}: ${reason}` };
    emit({ type: 'warning', message: `Guardrail '${guardrail}' withheld the answer: ${reason}` });
    return { kind: 'answer', answer: shown };
  }
  if (schema == null) return { kind: 'answer', answer: shown };
  const parsed = parseStructuredOutput({ text: shown, schema, format: outputFormat });
  if (!parsed.ok) emit({ type: 'warning', message: `The answer matched the output schema, but guardrail rewrites (e.g. redaction) changed it so it no longer matches the output schema; result.output is omitted (${parsed.error})` });
  return { kind: 'answer', answer: shown, ...(parsed.ok ? { output: parsed.value } : {}) };
}
