/** Where a variant is in its lifecycle. Only `trial` (for its share of runs) and `active` variants change prompts. */
export type VariantStatus = 'candidate' | 'trial' | 'active' | 'rejected' | 'reverted';

/** Additive, prompt-level overlays: no code, no permission changes. */
export type VariantChange =
  /** Replaces one tool's description in the prompt. */
  | { kind: 'tool-description'; tool: string; text: string }
  /** A rule (at most 400 characters) added right after the library rules. */
  | { kind: 'system-rule'; text: string; position: 'after-rules' }
  /** Tools to prefer, in order. */
  | { kind: 'tool-order-hint'; tools: string[] }
  /** Advice on batching calls. */
  | { kind: 'batching-hint'; text: string };

/** One status change of a variant, with why it happened and the numbers behind it. */
export interface VariantEvent {
  at: number;
  status: VariantStatus;
  reason: string;
  evidence?: Record<string, unknown>;
}

/** A strategy variant of one agent: versioned data, never code. */
export interface StrategyVariant {
  id: string;
  agentName: string;
  label: string;
  changes: VariantChange[];
  status: VariantStatus;
  createdAt: number;
  /** `suggested` variants come from report findings and need the consumer's approval like any other. */
  createdBy: 'consumer' | 'suggested';
  /** Every status change, oldest first. */
  history: VariantEvent[];
  /** When it entered `trial`. */
  trialStartedAt?: number;
  /** When it became `active`, and the control's success rate then (what the rollout guard holds it to). */
  promotedAt?: number;
  baselineRate?: number;
  /** The finding a suggested variant came from. */
  source?: string;
}

/** What a consumer proposes. */
export interface ProposedVariant {
  label: string;
  changes: VariantChange[];
}

/** `createAigent({ learning: { strategy } })`; agents opt in with `strategy: true`. */
export interface StrategyOptions {
  /** Share of an agent's runs given the variant in trial (default 0.2). */
  trialShare?: number;
  /** Runs each arm needs before a trial can be decided (default 30). */
  minSamples?: number;
  /** One-sided significance level (default 0.05). */
  alpha?: number;
  /** Largest allowed rise in tokens or turns per successful run (default 0.1, i.e. 10%). */
  maxEfficiencyRegression?: number;
  /** An active variant is reverted when its recent rate falls this far below the rate it was promoted over (default 0.05). */
  tolerance?: number;
  /** Recent runs the rollout guard looks at (default 30). */
  window?: number;
  /** Trial runs after which an undecided trial is rejected (default 300). */
  maxTrialRuns?: number;
  /** Seed of the trial assignment (default 0): the same run id always gets the same arm. */
  seed?: number;
}

/** Strategy options with defaults filled in. */
export type ResolvedStrategyOptions = Required<StrategyOptions>;

/** What a run used, stored on its record as `strategy`. */
export interface RunStrategyRecord {
  /** The task's feature bucket (see `featureBucket`). */
  bucket: string;
  /** `trial` runs got the variant in trial on top of the active ones; `control` runs only the active ones. */
  arm: 'trial' | 'control';
  /** The variant in trial while this run started, whichever arm it got. */
  trialVariantId?: string;
  /** Active variants applied, sorted. */
  activeVariantIds: string[];
}

/** `ai.learning.strategy`. */
export interface StrategyApi {
  /** Adds a consumer variant as a `candidate` (validated and checked for secrets and instruction-like text). */
  propose(agentName: string, variant: ProposedVariant): Promise<StrategyVariant>;
  /**
   * Candidates from the agent's report findings (e.g. `unbatched-repeats` gives a batching hint), each still needing
   * `approve`; findings already suggested are not repeated, and findings that could not become one are listed in `skipped`.
   */
  suggest(agentName: string): Promise<{ created: StrategyVariant[]; skipped: { source: string; reason: string }[] }>;
  /** Starts a candidate's trial (one trial per agent at a time). */
  approve(id: string): Promise<StrategyVariant>;
  /** Rejects a candidate or stops a trial. */
  reject(id: string, reason?: string): Promise<StrategyVariant>;
  /** Reverts an active variant by hand. */
  revert(id: string, reason?: string): Promise<StrategyVariant>;
  /** Deletes a variant; with none left the agent's prompt is exactly its baseline again. */
  remove(id: string): Promise<boolean>;
  get(id: string): Promise<StrategyVariant | undefined>;
  list(agentName?: string): Promise<StrategyVariant[]>;
  /** Runs the trial and rollout checks now (they also run at the start of each of the agent's runs). */
  evaluate(agentName: string): Promise<StrategyVariant[]>;
  /** Lessons from similar tasks users rated incorrect with expected answers, saved to memory (needs memory on). */
  lessons(agentName: string): Promise<{ saved: number; problems: string[] }>;
}
