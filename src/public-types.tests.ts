import { describe, expect, it } from 'vitest';
import type {
  Clock, CompareAndSetParams, Directive, FinishReason, IdGenerator, JsonSchema, MessageRole, ModelSettings, ProviderSettings, ProviderToolSpec, RandomSource, ResiliencePolicy,
  RunRecord, RunRecordFallback, RuntimeOnlySettings, SettingsContext, OpenAiTokenLimitField, ReasoningModelMatcher, Sleeper, ThinkingBlock, ToolErrorCategory, ToolFailureInit, UpdateRecordParams, KeySnapshot, LanePriority, Lease, LeaseRequest, LeaseUsage, ProviderLimits, QueuedInfo,
  QueueReason, RateLimitReport, Scheduler, SchedulerOptions, SchedulerSnapshot, UsageReport,
  AgentReport, AgentScores, CacheFindings, ComparisonMetrics, Finding, FindingKind, FindingSeverity, ModelPrice, Pricing, Report, ReportFilter, RequestAnalysis,
  RunMetrics, Score, ScoreLabel, ToolSuggestion, VersionComparison, VersionSide, WastedStepReason, ToolUse,
  AgentFeedbackEntry, AgentFeedbackKind, AgentFeedbackRecord, OutcomeSummary, ResponseIndexRecord, UserFeedback, UserFeedbackHistoryEntry, UserFeedbackRecord, UserRating, ItemCounts, OutcomeSource, PurgeFilter, RecordMeta, Redact, RedactableRecord, RetentionOptions, RunMode, RunTimings, RunTrace, StepOutcome, TraceRecord, TraceStep,
} from './index.js';
import type { CacheEntry, CacheEntryStats, CacheOptions, DeterministicCandidate, FrequentInvalidation, HotCacheEntry } from './index.js';
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
    const meta: RecordMeta = { schemaVersion: 1, runId: 'r', agentName: 'a', instanceId: 'i', mode: 'task', agentVersion: 'v', recordedAt: 0 };
    const mode: RunMode = meta.mode;
    const outcomeSource: OutcomeSource = 'directive';
    const outcome: StepOutcome = { success: true, answer: 'found', source: outcomeSource };
    const step: TraceStep = { index: 0, turn: 1, callId: 'c', tool: 't', argsSummary: '{}', ok: true, resultBytes: 1, resultTokens: 1, truncated: false, durationMs: 1, startedAtMs: 0, outcome };
    const traceRecord: TraceRecord = { ...meta, steps: [step] };
    const timings: RunTimings = { startedAt: 0, durationMs: 1, modelMs: 1, toolMs: 0, queuedMs: 0 };
    const runTrace: Pick<RunTrace, 'steps'> = { steps: traceRecord.steps };
    const redactable: RedactableRecord = { collection: 'runs', key: 'r', value: {} };
    const redact: Redact = record => record;
    const retention: RetentionOptions = { expiresInMs: 1_000 };
    const purgeFilter: PurgeFilter = { agentName: 'a', before: 0 };
    const itemCounts: ItemCounts = { total: 2, failed: 1 };
    const feedbackKind: AgentFeedbackKind = 'simplify';
    const feedbackEntry: AgentFeedbackEntry = { kind: feedbackKind, text: 'A find_config tool', relatedTool: 'search' };
    const feedbackRecord: AgentFeedbackRecord = { ...meta, kind: 'agent', callId: 'c', index: 0, entry: feedbackEntry };
    const outcomeSummary: OutcomeSummary = { claimedSuccess: 1, claimedFailure: 0 };
    const rating: UserRating = 'partial';
    const userFeedback: UserFeedback = { responseId: 'resp_1', rating, comment: 'close' };
    const historyEntry: UserFeedbackHistoryEntry = { at: 1, rating };
    const userRecord: UserFeedbackRecord = { ...meta, kind: 'user', responseId: 'resp_1', rating, history: [historyEntry] };
    const responseIndex: ResponseIndexRecord = { ...meta, responseId: 'resp_1' };
    expect({ userFeedback, userRecord, responseIndex }).toMatchObject({ userFeedback: { rating: 'partial' } });
    const price: ModelPrice = { inputPerMTokUsd: 3, outputPerMTokUsd: 15 };
    const pricing: Pricing = { 'anthropic:claude-sonnet-5-5': price };
    const scoreLabel: ScoreLabel = 'fast';
    const score: Score = { value: 75, label: scoreLabel, evidence: 'e' };
    const scores: AgentScores = { speed: score, tokenEfficiency: score, turnEfficiency: score, toolEfficiency: score, cost: score, reliability: score };
    const metrics: RunMetrics = { durationMs: 1, tokens: 1, turns: 1, toolCalls: 1, toolCallsPerTurn: 1, costUsd: null };
    const agentReport: AgentReport = { agentName: 'a', agentVersion: 'v', runs: 1, scores, totals: { tokens: 1, costUsd: null, durationMs: 1, turns: 1, toolCalls: 1 }, medians: metrics, p90s: metrics };
    const findingKind: FindingKind = 'slow-tool';
    const severity: FindingSeverity = 'warn';
    const finding: Finding = { id: 'slow-tool:a:read', kind: findingKind, severity, label: 'slow', agentName: 'a', subject: 'read', message: 'm', evidence: {} };
    const cache: CacheFindings = { hottest: [{ tool: 'read', key: 'global:k', hits: 2, savedMs: 10 }], hitRateByTool: { read: 0.5 }, hitRateByAgent: { a: 0.5 }, worthMarkingDeterministic: [{ tool: 'search', repeatedIdenticalCalls: 6 }], frequentlyInvalidated: [{ tool: 'read', invalidations: 3, lookups: 4 }] };
    const comparisonMetrics: ComparisonMetrics = { durationMs: 1, tokens: null, turns: null, toolCallsPerTurn: null, costUsd: null, reliability: null };
    const side: VersionSide = { version: 'v', runs: 1, medians: comparisonMetrics };
    const comparison: VersionComparison = { before: side, after: side, deltas: comparisonMetrics };
    const wasted: WastedStepReason = 'repeat-call';
    const request: RequestAnalysis = {
      groupId: 'g', sampleTask: 't', runs: 1, successfulRuns: 1, typical: { medianTokens: 1, medianTurns: 1, medianToolCalls: 1 },
      wastedSteps: [{ runId: 'r', stepIndex: 0, reason: wasted }], potentialSaving: { tokens: 0, turns: 0 },
    };
    const suggestion: ToolSuggestion = {
      name: 'search_then_read', description: 'd', replaces: ['search -> read'], supportingRunIds: ['r'], proposedArgs: [{ name: 'query', type: 'string' }],
      estimatedSaving: { tokensPerUse: 1, turnsPerUse: 1, timePerUseMs: 1 },
    };
    const reportFilter: ReportFilter = { agentName: 'a', compareVersions: ['v1', 'v2'], minRuns: 5, includeDisabled: false };
    const toolUse: ToolUse = { calls: 1, items: 1, repeats: 0 };
    const report: Report = { generatedAt: 0, filter: reportFilter, runCount: 1, agents: [agentReport], findings: [finding], requests: [request], toolSuggestions: [suggestion], agentFeedback: [], cache, comparison };
    expect({ pricing, report, toolUse }).toMatchObject({ report: { runCount: 1 } });
    expect({ mode, timings, runTrace, redactable, redact, retention, purgeFilter, itemCounts, feedbackRecord, outcomeSummary }).toMatchObject({ mode: 'task' });
    expect({ spec, role, finishReason, directive, category, turnOptions, textTurnOptions, failureInit, casParams, updateParams, providerSettings, recordSettings, resilience, fallback, runtimeOnly, settingsContext, tokenLimitField, isReasoningModel, thinkingBlocks, sleep, random, clock, ids, schedulerOptions, queuedInfo, usage, rateLimit, usageReport, leaseRequest, scheduler }).toMatchObject({ spec: { name: 'echo' }, role: 'assistant' });
  });

  it('lets consumers name the tool-result cache types', () => {
    const options: CacheOptions = { maxEntries: 10, maxBytes: 1_000, maxEntryBytes: 100 };
    const stats: CacheEntryStats = {
      firstStoredBy: { agentName: 'a', runId: 'r' }, totalHits: 1, hitsByAgent: { a: 1 }, missesByAgent: {}, lastRequestedAt: 0, missCount: 1, invalidationCount: 0, savedMs: 1, savedTokens: 1,
    };
    const entry: CacheEntry = { schemaVersion: 1, namespace: 'global', tool: 'read', storedAt: 0, value: 'x', bytes: 3, originalDurationMs: 1, resultTokens: 1, stats };
    const hot: HotCacheEntry = { tool: 'read', key: 'global:k', hits: 1, savedMs: 1 };
    const candidate: DeterministicCandidate = { tool: 'search', repeatedIdenticalCalls: 3 };
    const invalidation: FrequentInvalidation = { tool: 'read', invalidations: 3, lookups: 4 };
    expect({ options, entry, hot, candidate, invalidation }).toMatchObject({ entry: { tool: 'read' } });
  });
});
