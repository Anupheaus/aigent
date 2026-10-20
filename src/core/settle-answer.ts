import { OUTPUT_INVALID_CODE, parseStructuredOutput } from '../guardrails/builtin/output-schema.js';
import type { GuardrailRunContext } from '../guardrails/guardrail-types.js';
import type { AigentEvent } from './aigent-events.js';
import type { RunGuardrails } from './run-guardrails.js';

/** The final answer after the output guardrails: kept (maybe rewritten), to be retried, or failed. */
export type SettledAnswer =
  | { kind: 'answer'; answer: string; output?: unknown }
  | { kind: 'retry'; feedback: string }
  | { kind: 'failed'; answer: string; failure: string };

export interface SettleAnswerParams {
  text: string;
  guardrails?: RunGuardrails;
  /** The task's structured output, when it has one. */
  structured: GuardrailRunContext;
  /** Turns left to fix an answer that fails the `output` schema. */
  retriesLeft: number;
  emit(event: AigentEvent): void;
}

/**
 * Runs the `output` stage on the model's final text. An answer failing the task's `output` schema is sent back with
 * the issues while retries are left, then fails the run (`output_invalid`); any other block withholds the answer.
 */
export async function settleAnswer(params: SettleAnswerParams): Promise<SettledAnswer> {
  const { text, guardrails, structured: { output: schema, outputFormat = 'json' }, retriesLeft, emit } = params;
  const verdict = guardrails == null ? { answer: text } : await guardrails.checkOutput(text);
  if ('blocked' in verdict) {
    const { guardrail, code, reason } = verdict.blocked;
    if (code === OUTPUT_INVALID_CODE) {
      if (retriesLeft > 0) return { kind: 'retry', feedback: `Your answer was not accepted: ${reason}. Reply again with only the corrected answer.` };
      return { kind: 'failed', answer: text, failure: `${OUTPUT_INVALID_CODE}: ${reason}` };
    }
    emit({ type: 'warning', message: `Guardrail '${guardrail}' withheld the answer: ${reason}` });
    return { kind: 'answer', answer: `[answer withheld by guardrail '${guardrail}': ${reason}]` };
  }
  if (schema == null) return { kind: 'answer', answer: verdict.answer };
  const parsed = parseStructuredOutput({ text: verdict.answer, schema, format: outputFormat });
  return { kind: 'answer', answer: verdict.answer, ...(parsed.ok ? { output: parsed.value } : {}) };
}
