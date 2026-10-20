import { createCompactor } from '../context/compactor.js';
import type { Compactor, WrittenSummary } from '../context/compactor.js';
import type { CompactionPolicy } from '../context/compaction-policy.js';
import type { ContextMessage } from '../context/context-message.js';
import { toProviderMessages } from '../context/context-message.js';
import { estimatePromptTokens } from '../context/estimate-prompt-tokens.js';
import { summaryMessageText, summaryRequestMessages } from '../context/summarise.js';
import { createAigentError } from './aigent-error.js';
import type { AigentEvent } from './aigent-events.js';
import { openTurnStream } from './open-turn-stream.js';
import type { TurnRouting } from './open-turn-stream.js';
import { raceSignal } from './race-signal.js';
import { issueContextMessage } from './run-context.js';
import type { RunContext } from './run-context.js';
import type { RunOriginals } from './run-originals.js';
import type { RunTotals } from './run-turn.js';
import type { RunVolatile } from './run-volatile.js';
import type { Clock } from './runtime-services.js';
import { stopStream } from './stop-stream.js';

/** How one run compacts: its policy, its usable prompt budget and the models that write summaries. */
export interface RunCompactionSettings {
  policy: CompactionPolicy;
  usableBudget: number;
  /** `compactionModel` when set, otherwise the run's own models; scheduler and resilience apply as for any turn. */
  summariser: TurnRouting;
}

export interface CreateRunCompactionParams {
  settings: RunCompactionSettings;
  context: RunContext;
  originals: RunOriginals;
  volatile: RunVolatile;
  clock: Clock;
  totals: RunTotals;
  signal: AbortSignal;
  emit(event: AigentEvent): void;
}

interface SummariseParams {
  run: CreateRunCompactionParams;
  request: { previousSummary?: string; messages: ContextMessage[] };
}

/** Streams the summariser through the normal provider path; its usage counts toward the run and `compactionTokens`. */
async function writeSummary(params: SummariseParams): Promise<WrittenSummary> {
  const { run: { settings: { summariser }, totals, signal, emit }, request } = params;
  const stream = openTurnStream({ routing: summariser, request: { messages: summaryRequestMessages(request), tools: [] }, signal, counters: totals, emit });
  const iterator = stream[Symbol.asyncIterator]();
  let text = '';
  let usageTokens = 0;
  let isAbandoned = false;
  try {
    for (;;) {
      const raced = await raceSignal({ work: iterator.next(), signal });
      if (raced.isAborted) {
        isAbandoned = true;
        throw createAigentError({ code: 'aborted', message: 'The run was aborted while writing a compaction summary' });
      }
      if (raced.value.done === true) break;
      const event = raced.value.value;
      if (event.type === 'text-delta') text += event.text;
      if (event.type === 'usage') {
        const { inputTokens, outputTokens, cachedTokens } = event.usage;
        totals.usage.inputTokens += inputTokens;
        totals.usage.outputTokens += outputTokens;
        totals.usage.cachedTokens += cachedTokens;
        usageTokens += inputTokens + outputTokens;
      }
    }
  } finally {
    if (isAbandoned) stopStream(iterator);
  }
  totals.compactionTokens += usageTokens;
  if (text.trim() === '') throw createAigentError({ code: 'provider_failed', message: 'The compaction summariser returned no text' });
  return { text, usageTokens };
}

/** The run's compactor, wired to its stored messages, originals, volatile block and summariser. */
export function createRunCompaction(params: CreateRunCompactionParams): Compactor {
  const { settings: { policy, usableBudget }, context, originals, volatile, clock, emit } = params;
  return createCompactor({
    context, policy, usableBudget, emit,
    // The volatile block is not rebuilt here: building it consumes one-shot sections (corrections) meant for the request.
    estimateRaw: () => estimatePromptTokens({ messages: toProviderMessages(context.state), tools: originals.registry().specs() }) + context.volatileTokens,
    keepOriginal: text => originals.keep(text),
    summarise: request => writeSummary({ run: params, request }),
    createSummary: text => issueContextMessage({ context, entry: { kind: 'summary', message: { role: 'user', text: summaryMessageText(text) } }, createdAt: clock.now() }),
    // A compaction is the one deliberate prefix change; the monitor must not report it.
    onCompacted: () => volatile.monitor.acceptChange(),
  });
}
