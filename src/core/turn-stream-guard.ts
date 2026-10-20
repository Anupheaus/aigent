import type { AigentEvent } from './aigent-events.js';
import type { RunGuardrails } from './run-guardrails.js';

/**
 * One turn's streamed text through the `stream` guardrails: the answer and the reasoning each have their own
 * hold-back, so a secret split across chunks is checked whole before any of it is shown. Without stream guardrails
 * everything passes as it arrives.
 */
export interface TurnStreamGuard {
  /** Answer text in; what may be shown now out (possibly ''). */
  text(text: string): string;
  /** Reasoning text in; what may be shown now out. */
  thinking(text: string): string;
  /** Releases the reasoning still held (the reasoning stream ended, or something else arrived). */
  endThinking(): string;
  /** Releases the answer text still held at the end of the turn. */
  endText(): string;
}

/** Shows the reasoning the guard still held: before anything else of the turn is shown, and at its end. */
export function flushThinking(params: { guard: TurnStreamGuard; emit(event: AigentEvent): void }): void {
  const { guard, emit } = params;
  const held = guard.endThinking();
  if (held !== '') emit({ type: 'thinking-delta', text: held });
}

export function createTurnStreamGuard(guardrails?: RunGuardrails): TurnStreamGuard {
  const answer = guardrails?.stream();
  const reasoning = guardrails?.stream();
  return {
    text: text => (answer == null || text === '' ? text : answer.push(text)),
    thinking: text => (reasoning == null || text === '' ? text : reasoning.push(text)),
    endThinking: () => reasoning?.end() ?? '',
    endText: () => answer?.end() ?? '',
  };
}
