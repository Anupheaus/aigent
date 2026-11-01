import { isReproducible } from '../cache/response-cache.js';
import type { ResponseCache } from '../cache/response-cache.js';
import type { ProviderEvent, ToolCall, Usage } from '../providers/provider-types.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ProviderTarget, TurnRequest } from './open-turn-stream.js';

/** A run's view of the response cache: which agent version and instance its entries belong to. */
export interface RunResponseCache {
  cache: ResponseCache;
  /** The run's effective agent version (learned variants and skills included). */
  agentVersion: string;
  instanceId: string;
}

export interface CachedTurnParams {
  responseCache: RunResponseCache;
  target: ProviderTarget;
  request: TurnRequest;
  registry: ToolRegistry;
  /** The run's previous round ran a tool with side effects: the world may differ from what the messages say. */
  previousRoundHadSideEffects: boolean;
  /** Opens the live stream (retries, fallbacks). */
  open(): AsyncIterable<ProviderEvent>;
  /** Whether the live stream moved to a fallback model (its response then belongs to another model). */
  didFallback(): boolean;
}

/** A replayed response costs nothing: its usage is reported as zero (and the run marks it `cachedResponse`). */
const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

function isCacheableTool(params: { name: string; registry: ToolRegistry }): boolean {
  const tool = params.registry.get(params.name);
  return tool != null && tool.deterministic && tool.cache;
}

/** Replaying a response re-runs its tool calls, so only calls that are safe to repeat (deterministic, cached) qualify. */
function isReplayableCall(params: { call: ToolCall; registry: ToolRegistry }): boolean {
  const { call: { name, args }, registry } = params;
  if (name !== MULTI_TOOL_NAME) return isCacheableTool({ name, registry });
  const inner = (args as { calls?: { tool?: unknown }[] } | null)?.calls;
  return Array.isArray(inner) && inner.every(({ tool }) => typeof tool === 'string' && isCacheableTool({ name: tool, registry }));
}

/** Whether a round's calls may have changed something: a tool with side effects, directly or inside a wrapper. */
export function roundHasSideEffects(params: { calls: ToolCall[]; registry: ToolRegistry }): boolean {
  const { calls, registry } = params;
  const hasEffects = (name: string): boolean => {
    const tool = registry.get(name);
    return tool == null || tool.hasSideEffects || (tool.composedTools ?? []).some(composed => registry.get(composed)?.hasSideEffects !== false);
  };
  return calls.some(({ name, args }) => {
    if (name !== MULTI_TOOL_NAME) return hasEffects(name);
    const inner = (args as { calls?: { tool?: unknown }[] } | null)?.calls ?? [];
    return inner.some(({ tool }) => typeof tool !== 'string' || hasEffects(tool));
  });
}

async function* replay(events: ProviderEvent[]): AsyncIterable<ProviderEvent> {
  let hasUsage = false;
  for (const event of events) {
    if (event.type === 'usage') { hasUsage = true; yield { type: 'usage', usage: ZERO_USAGE }; continue; }
    if (event.type === 'done' && !hasUsage) yield { type: 'usage', usage: ZERO_USAGE };
    yield event;
  }
}

/** Passes the live stream through and stores it once it completed normally with only replayable calls. */
async function* record(params: { live: AsyncIterable<ProviderEvent>; store(events: ProviderEvent[]): void; registry: ToolRegistry; didFallback(): boolean }): AsyncIterable<ProviderEvent> {
  const { live, store, registry, didFallback } = params;
  const events: ProviderEvent[] = [];
  let isDone = false;
  // An error or an abandoned stream (the consumer stopped early) ends here without storing anything.
  for await (const event of live) {
    events.push(event);
    if (event.type === 'done') isDone = true;
    yield event;
  }
  const isReplayable = events.every(event => event.type !== 'tool-call' || isReplayableCall({ call: event.call, registry }));
  if (isDone && isReplayable && !didFallback()) store(events);
}

/**
 * The turn's stream through the response cache: a fresh identical request (same provider, model, settings, messages,
 * tools and agent version, and instance unless shared) is replayed, else the live response is recorded. Requests whose
 * sampling is not reproducible, or that follow a round with side effects, always go live and are never stored.
 */
export function openCachedTurn(params: CachedTurnParams): { stream: AsyncIterable<ProviderEvent>; isHit: boolean } {
  const { responseCache: { cache, agentVersion, instanceId }, target, request, registry, previousRoundHadSideEffects, open, didFallback } = params;
  if (!isReproducible(target.settings) || previousRoundHadSideEffects) return { stream: open(), isHit: false };
  const key = cache.key({
    providerId: target.provider.id, model: target.model, settings: target.settings ?? {}, messages: request.messages, tools: request.tools, agentVersion,
    scope: cache.isShared ? 'shared' : instanceId,
  });
  const stored = cache.get(key);
  if (stored != null) return { stream: replay(stored), isHit: true };
  return { stream: record({ live: open(), store: events => cache.set(key, events), registry, didFallback }), isHit: false };
}
