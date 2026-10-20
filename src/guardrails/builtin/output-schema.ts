import { z } from 'zod';
import { describeIssues } from '../../core/describe-issues.js';
import type { Guardrail, GuardrailRunContext } from '../guardrail-types.js';

/** Extra turns to fix an invalid structured answer. */
export const DEFAULT_OUTPUT_RETRIES = 2;
/** The block code of an answer that does not match the task's `output` schema. */
export const OUTPUT_INVALID_CODE = 'output_invalid';

const CODE_FENCE = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;

export type StructuredOutput = { ok: true; value: unknown } | { ok: false; error: string };

/** The answer as the schema's value: JSON (a surrounding code fence is allowed) or, with `text`, the text itself. */
export function parseStructuredOutput(params: { text: string; schema: z.ZodType; format: 'json' | 'text' }): StructuredOutput {
  const { text, schema, format } = params;
  let candidate: unknown = text;
  if (format === 'json') {
    try {
      candidate = JSON.parse(CODE_FENCE.exec(text)?.[1] ?? text);
    } catch (error) {
      return { ok: false, error: `the answer is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
    }
  }
  const parsed = schema.safeParse(candidate);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: `the answer does not match the required output: ${describeIssues(parsed.error)}` };
}

/** Validates the final answer against the task's `output` schema (the run then asks the model to fix it, see `outputRetries`). */
export function outputSchemaGuardrails(run: GuardrailRunContext): Guardrail[] {
  const { output, outputFormat = 'json' } = run;
  if (output == null) return [];
  return [{
    name: 'output-schema', stage: 'output',
    check: value => {
      const parsed = parseStructuredOutput({ text: typeof value === 'string' ? value : '', schema: output, format: outputFormat });
      return parsed.ok ? { action: 'allow' } : { action: 'block', code: OUTPUT_INVALID_CODE, reason: parsed.error };
    },
  }];
}

/** The brief's note telling the model the answer's required form (JSON matching the schema, or text that does). */
export function outputInstructions(run: GuardrailRunContext): string | undefined {
  const { output, outputFormat = 'json' } = run;
  if (output == null) return undefined;
  const schema = JSON.stringify(z.toJSONSchema(output, { target: 'draft-7', io: 'input' }));
  return outputFormat === 'json'
    ? `# Output\nYour final answer must be only JSON (no other text) matching this JSON schema:\n${schema}`
    : `# Output\nYour final answer must be only text matching this JSON schema:\n${schema}`;
}
