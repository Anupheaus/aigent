import { redactPersonalData } from '../guardrails/builtin/pii.js';
import { redactSecrets } from '../guardrails/builtin/secrets.js';

export interface ScrubMemoryTextParams {
  text: string;
  /** Personal data is redacted too (the runtime's pii guardrail redacts). */
  redactsPii?: boolean;
}

/**
 * Note text with secrets (and, when asked, personal data) replaced by `[REDACTED:<kind>]`. Memory outlives the run and
 * is shown to later runs, other sessions and other users of the same agent, which no guardrail stage reaches, so it is
 * redacted whatever the guardrails are set to.
 */
export function scrubMemoryText(params: ScrubMemoryTextParams): string {
  const { text, redactsPii = false } = params;
  const { text: withoutSecrets } = redactSecrets(text);
  return redactsPii ? redactPersonalData(withoutSecrets) : withoutSecrets;
}
