import type { CacheFindings } from '../cache/cache-types.js';
import type { AgentFeedbackKind } from '../feedback/feedback-records.js';

export type { CacheFindings };

/** Which runs `ai.report()` covers. Every given field must match. */
export interface ReportFilter {
  agentName?: string;
  instanceId?: string;
  /** Matches the agent version hash or the definition's human `version` label. */
  agentVersion?: string;
  /** Epoch ms: runs that started at or after it. */
  since?: number;
  label?: string;
  unattended?: boolean;
  /** `disableTelemetry` runs are never stored, so they are always excluded; only `false` is accepted. */
  includeDisabled?: false;
  /** Two agent versions (hash or label) to compare, before then after. */
  compareVersions?: [string, string];
  /** Earlier runs of the same agent version a run needs before it is scored (default 5). */
  minRuns?: number;
}

/** Prices in US dollars per million tokens, keyed `provider:model`. */
export interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  /** Price of cached input tokens; the input price when absent. */
  cachedInputPerMTokUsd?: number;
}

export type Pricing = Record<string, ModelPrice>;

export type ScoreLabel = 'fast' | 'slow' | 'efficient' | 'inefficient' | 'average' | 'insufficient-data';

/** One score, 0 to 100 (50 means "like this agent version's own recent runs"), or null without enough history. */
export interface Score {
  value: number | null;
  label: ScoreLabel;
  /** The numbers behind the score, in words. */
  evidence: string;
}

export interface AgentScores {
  /** Duration against the rolling baseline. */
  speed: Score;
  /** Tokens (cached input weighted 0.1) against the baseline. */
  tokenEfficiency: Score;
  /** Tool calls per turn and turn count against the baseline. */
  turnEfficiency: Score;
  /** Batch items per call and the share of calls that are not repeats, against the baseline. */
  toolEfficiency: Score;
  /** Cost against the baseline; null without pricing. */
  cost: Score;
  /** Share of runs that completed without more tool failures than usual and were not rated incorrect. */
  reliability: Score;
}

/** Per-run figures summarised by median and p90. */
export interface RunMetrics {
  durationMs: number;
  /** Input + output tokens, cached input weighted 0.1. */
  tokens: number;
  turns: number;
  toolCalls: number;
  toolCallsPerTurn: number;
  /** Null without pricing for the run's model. */
  costUsd: number | null;
}

export interface AgentReport {
  agentName: string;
  agentVersion: string;
  /** Runs of this version in the report. */
  runs: number;
  scores: AgentScores;
  totals: { tokens: number; costUsd: number | null; durationMs: number; turns: number; toolCalls: number };
  medians: RunMetrics;
  p90s: RunMetrics;
}

export type FindingKind =
  | 'slow-tool'
  | 'failing-tool'
  | 'verbose-tool'
  | 'unbatched-repeats'
  | 'too-many-turns'
  | 'high-retry-rate'
  | 'claimed-success-user-incorrect'
  | 'expensive-run'
  | 'slow-run'
  | 'truncation-frequent'
  /** A shaper whose output was not smaller than its input, summed over the agent's runs. */
  | 'net-negative-shaper'
  /** Reserved for the guardrails slice. */
  | 'guardrail';

export type FindingSeverity = 'info' | 'warn' | 'bad';

/** One heuristic observation, with the numbers behind it. */
export interface Finding {
  /** Stable: `${kind}:${agentName}:${subject}`. */
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  label: 'fast' | 'slow' | 'efficient' | 'inefficient';
  agentName: string;
  /** What the finding is about: a tool name or a run id. */
  subject: string;
  message: string;
  evidence: Record<string, unknown>;
}


/** Medians compared across two versions; null where a side has no data (e.g. no pricing). */
export interface ComparisonMetrics {
  durationMs: number | null;
  tokens: number | null;
  turns: number | null;
  toolCallsPerTurn: number | null;
  costUsd: number | null;
  /** Percentage of runs that completed and were not rated incorrect. */
  reliability: number | null;
}

export interface VersionSide {
  /** As given in `compareVersions`. */
  version: string;
  runs: number;
  medians: ComparisonMetrics;
}

export interface VersionComparison {
  before: VersionSide;
  after: VersionSide;
  /** after minus before. */
  deltas: ComparisonMetrics;
}

/** Why a step counts as wasted in request analysis. */
export type WastedStepReason = 'failed-before-success' | 'repeat-call' | 'unbatched' | 'superseded-search';

/** How a group of similar tasks was solved, and how it could be solved more cheaply. */
export interface RequestAnalysis {
  groupId: string;
  /** One task text of the group ('' without content capture); the label when grouped by label. */
  sampleTask: string;
  runs: number;
  /** Runs whose agent claimed success on its last outcome and that no user rated incorrect. */
  successfulRuns: number;
  cheapestSuccessful?: { runId: string; tokens: number; turns: number; toolCalls: number; durationMs: number; path: string[] };
  typical: { medianTokens: number; medianTurns: number; medianToolCalls: number };
  wastedSteps: { runId: string; stepIndex: number; reason: WastedStepReason }[];
  potentialSaving: { tokens: number; turns: number };
}

/** A tool that would replace a recurring multi-step sequence. */
export interface ToolSuggestion {
  /** snake_case from the sequence's tool names, e.g. `search_then_read`. */
  name: string;
  description: string;
  /** The sequences it replaces, as `a -> b` strings. */
  replaces: string[];
  supportingRunIds: string[];
  /** Union of the argument keys seen at the sequence's first step. */
  proposedArgs: { name: string; type: string }[];
  estimatedSaving: { tokensPerUse: number; turnsPerUse: number; timePerUseMs: number };
}

/** How many `aigent_feedback` entries had one kind. */
export interface AgentFeedbackKindCount {
  kind: AgentFeedbackKind;
  count: number;
}

/** `aigent_feedback` entries about one tool (`relatedTool`). */
export interface AgentFeedbackToolCount {
  tool: string;
  count: number;
  /** Most frequent first, then by kind. */
  byKind: AgentFeedbackKindCount[];
}

/** One stored `aigent_feedback` entry with its text (only entries stored with content capture on). */
export interface AgentFeedbackQuote {
  runId: string;
  /** Epoch ms the entry's run was recorded. */
  recordedAt: number;
  kind: AgentFeedbackKind;
  relatedTool?: string;
  text: string;
}

/** What one agent said through `aigent_feedback` over the report's runs. */
export interface AgentFeedbackSummary {
  agentName: string;
  /** Every entry, with or without stored text. */
  total: number;
  /** Most frequent first, then by kind. */
  byKind: AgentFeedbackKindCount[];
  /** Entries naming a tool, most frequent first, then by tool name. */
  byTool: AgentFeedbackToolCount[];
  /** The newest entries that have text, newest first; at most 10 (`MAX_RECENT_AGENT_FEEDBACK`). */
  recent: AgentFeedbackQuote[];
}

export interface Report {
  /** Epoch ms. */
  generatedAt: number;
  /** The filter applied, with defaults filled in. */
  filter: ReportFilter;
  runCount: number;
  /** One per agent name and version, sorted by both. */
  agents: AgentReport[];
  /** Severity (bad, warn, info), then id. */
  findings: Finding[];
  requests: RequestAnalysis[];
  toolSuggestions: ToolSuggestion[];
  /** What each agent reported through `aigent_feedback` on the report's runs, sorted by agent name. */
  agentFeedback: AgentFeedbackSummary[];
  cache: CacheFindings;
  comparison?: VersionComparison;
}
