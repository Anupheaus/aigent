import type { AigentEvent } from '../core/aigent-events.js';
import type { ProviderMessage, ProviderToolSpec } from '../providers/provider-types.js';
import { computePrefixHash } from './prefix-hash.js';

export const PREFIX_CHANGED_WARNING = 'Prompt prefix changed between turns without a compaction; a block is changing every turn and defeats provider prompt caching. Move changing content to the volatile block.';

export interface CreateStabilityMonitorParams {
  emit(event: AigentEvent): void;
  /** Dev only by default (`NODE_ENV !== 'production'`), or as `volatile.warnOnPrefixChange` says. */
  isEnabled: boolean;
}

/** One request's stable part: the stored messages and the tool specs. */
export interface PrefixObservation {
  messages: ProviderMessage[];
  tools: ProviderToolSpec[];
}

export interface StabilityMonitor {
  /** Checks that the previous request's prefix is still the start of this one (history only grew at the tail). */
  observe(observation: PrefixObservation): void;
  /** The next observation may differ from the previous one (a rewritten pinned block, a compaction). */
  acceptChange(): void;
}

/** Warns once per run when the prompt prefix changes between turns, which defeats provider prompt caching. */
export function createStabilityMonitor(params: CreateStabilityMonitorParams): StabilityMonitor {
  const { emit, isEnabled } = params;
  let previous: { count: number; hash: string } | undefined;
  let isChangeAccepted = false;
  let hasWarned = false;

  function observe(observation: PrefixObservation): void {
    if (!isEnabled) return;
    const { messages, tools } = observation;
    if (previous != null && !isChangeAccepted && !hasWarned) {
      const { count, hash } = previous;
      const isExtension = messages.length >= count && computePrefixHash(messages.slice(0, count), tools) === hash;
      if (!isExtension) {
        hasWarned = true;
        emit({ type: 'warning', message: PREFIX_CHANGED_WARNING });
      }
    }
    previous = { count: messages.length, hash: computePrefixHash(messages, tools) };
    isChangeAccepted = false;
  }

  return { observe, acceptChange: () => { isChangeAccepted = true; } };
}
