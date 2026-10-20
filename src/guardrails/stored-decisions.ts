import type { GuardrailDecisionRecord } from './guardrail-types.js';

/** Decisions as stored: with content capture off, the message (which may quote content) is left empty. */
export function storedDecisions(params: { decisions: GuardrailDecisionRecord[]; captureContent: boolean }): GuardrailDecisionRecord[] {
  const { decisions, captureContent } = params;
  return captureContent ? decisions.map(decision => ({ ...decision })) : decisions.map(decision => ({ ...decision, message: '' }));
}
