import { describe, expect, it } from 'vitest';
import type {
  Clock, CompareAndSetParams, Directive, FinishReason, IdGenerator, JsonSchema, MessageRole, ModelSettings, ProviderSettings, ProviderToolSpec, RandomSource, ResiliencePolicy,
  RunRecord, RunRecordFallback, RuntimeOnlySettings, SettingsContext, OpenAiTokenLimitField, ReasoningModelMatcher, Sleeper, ThinkingBlock, ToolErrorCategory, ToolFailureInit, UpdateRecordParams, KeySnapshot, LanePriority, Lease, LeaseRequest, LeaseUsage, ProviderLimits, QueuedInfo,
  QueueReason, RateLimitReport, Scheduler, SchedulerOptions, SchedulerSnapshot, UsageReport,
} from './index.js';
import type { TextTurnOptions, TurnOptions } from './testing/index.js';

// Compile-time check: every type that appears in a public signature can be named by consumers.
describe('public types', () => {
  it('lets provider authors and consumers name the parts of public signatures', () => {
    const parameters: JsonSchema = { type: 'object' };
    const spec: ProviderToolSpec = { name: 'echo', description: 'Echo text', parameters, strict: true };
    const role: MessageRole = 'assistant';
    const finishReason: FinishReason = 'stop';
    const directive: Directive = { type: 'status', data: { text: 'working' } };
    const category: ToolErrorCategory = 'timeout';
    const turnOptions: TurnOptions = { delayMs: 1 };
    const textTurnOptions: TextTurnOptions = { chunkSize: 2 };
    const failureInit: ToolFailureInit = { code: 'nope', message: 'no' };
    const casParams: CompareAndSetParams<number> = { collection: 'c', key: 'k', expectedVersion: undefined, value: 1 };
    const updateParams: Omit<UpdateRecordParams<number>, 'store'> = { collection: 'c', key: 'k', update: current => (current ?? 0) + 1 };
    const modelSettings: ModelSettings = { thinking: { budgetTokens: 2048 }, effort: 'high', showThinking: false };
    const providerSettings: ProviderSettings = { temperature: 0.5, stop: ['END'] };
    const recordSettings: RunRecord['settings'] = modelSettings;
    const resilience: Partial<ResiliencePolicy> = { maxRetries: 1, firstEventTimeoutMs: 10_000 };
    const fallback: RunRecordFallback = { model: 'b:m', settings: providerSettings, droppedSettings: ['seed'] };
    const runtimeOnly: RuntimeOnlySettings = { contextSize: 1_000 };
    const settingsContext: SettingsContext = { model: 'm' };
    const tokenLimitField: OpenAiTokenLimitField = 'max_completion_tokens';
    const isReasoningModel: ReasoningModelMatcher = model => model.startsWith('o');
    const thinkingBlocks: ThinkingBlock[] = [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'redacted-thinking', data: 'd' }];
    const sleep: Sleeper = async () => undefined;
    const random: RandomSource = () => 0.5;
    const clock: Clock = { now: () => 0 };
    const ids: IdGenerator = { next: prefix => prefix };
    const limits: ProviderLimits = { maxConcurrent: 2, requestsPerMinute: 60, tokensPerMinute: 100_000 };
    const schedulerOptions: SchedulerOptions = { limits: { anthropic: limits }, maxBackgroundWaitMs: 30_000 };
    const priority: LanePriority = 'background';
    const reason: QueueReason = 'tokens-per-minute';
    const queuedInfo: QueuedInfo = { position: 1, reason };
    const usage: LeaseUsage = { tokens: 10 };
    const lease: Lease = { release: () => undefined };
    const keySnapshot: KeySnapshot = { inFlight: 0, queued: 0, interactiveQueued: 0, backgroundQueued: 0 };
    const schedulerSnapshot: SchedulerSnapshot = { anthropic: keySnapshot };
    const rateLimit: RateLimitReport = { key: 'anthropic', retryAfterMs: 1 };
    const usageReport: UsageReport = { key: 'anthropic', tokens: 1 };
    const leaseRequest: LeaseRequest = { key: 'anthropic:m', estimatedTokens: 1, priority, agentName: 'a', signal: new AbortController().signal };
    const scheduler: Scheduler = { acquire: async () => lease, reportRateLimit: () => undefined, reportUsage: () => undefined, snapshot: () => schedulerSnapshot };
    expect({ spec, role, finishReason, directive, category, turnOptions, textTurnOptions, failureInit, casParams, updateParams, providerSettings, recordSettings, resilience, fallback, runtimeOnly, settingsContext, tokenLimitField, isReasoningModel, thinkingBlocks, sleep, random, clock, ids, schedulerOptions, queuedInfo, usage, rateLimit, usageReport, leaseRequest, scheduler }).toMatchObject({ spec: { name: 'echo' }, role: 'assistant' });
  });
});
