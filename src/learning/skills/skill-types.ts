import type { JsonSchema } from '../../providers/provider-types.js';

/** Where a skill is in its lifecycle. Only `active` skills are tools; `shadow` ones are advisory hints, never run. */
export type SkillStatus = 'candidate' | 'shadow' | 'active' | 'rejected' | 'retired';

/** Where one argument of a step comes from. Values are data: nothing in them is evaluated or expanded. */
export type ArgTemplate =
  /** The same in every supporting run, so baked in. */
  | { const: unknown }
  /** Varied across the supporting runs: a parameter of the skill. */
  | { param: string }
  /** Equal to a value an earlier step returned, at a JSON pointer into its result. */
  | { fromStep: number; path: string };

/** One tool call of a skill, run through the run's dispatcher like any call. */
export interface SkillStep {
  tool: string;
  args: Record<string, ArgTemplate>;
  /** `stop` skips the rest after a failure; `continue` runs them anyway. */
  onFailure: 'stop' | 'continue';
}

/** A worked example from a supporting run (kept for inspection; never shown to the model). */
export interface SkillExample {
  args: Record<string, unknown>;
  summary: string;
}

export interface SkillStats {
  supportingRuns: number;
  /** Share of supporting runs the validation replay reproduced (1 for every stored skill). */
  replayPass: number;
  /** Runs that called the skill. */
  uses: number;
  /** Weighted success of the runs that called it (0 before any). */
  successRate: number;
}

/** One status change of a skill, with why. */
export interface SkillEvent {
  at: number;
  version: number;
  status: SkillStatus;
  reason: string;
}

/** An earlier version of a skill, kept for `rollback`. */
export interface SkillSnapshot {
  version: number;
  status: SkillStatus;
  description: string;
  argsSchema: JsonSchema;
  steps: SkillStep[];
  preconditions: string[];
  examples: SkillExample[];
}

/** A reusable composed tool distilled from recurring successful traces. Versioned data, never code. */
export interface Skill {
  id: string;
  /** snake_case with the `skill_` prefix. */
  name: string;
  description: string;
  version: number;
  /** Strict JSON schema of the parameters (every property required, no others). */
  argsSchema: JsonSchema;
  steps: SkillStep[];
  preconditions: string[];
  examples: SkillExample[];
  stats: SkillStats;
  status: SkillStatus;
  createdAt: number;
  agentName: string;
  /** Distilled with `allowSideEffects`: each step with side effects asks a person at run time, whatever the rules say. */
  allowSideEffects?: boolean;
  /** The runs it was distilled from, sorted. */
  supportingRunIds: string[];
  history: SkillEvent[];
  previousVersions: SkillSnapshot[];
}

/** What distillation proposes: a skill before it is stored. */
export type SkillCandidate = Omit<Skill, 'id' | 'status' | 'createdAt' | 'version' | 'history' | 'previousVersions'>;

/** A sequence that did not become a skill, and why. */
export interface SkillRefusal {
  tools: string[];
  reason: string;
}

/** `ai.skills.distil` options. */
export interface DistilOptions {
  /** Distinct supporting runs needed (default 3, at least 2). */
  minSupport?: number;
  /** Longest sequence (default 6). */
  maxSteps?: number;
  /** Allow steps with side effects; each then needs a person's approval at run time. Default false. */
  allowSideEffects?: boolean;
}

/** What one `ai.skills.distil` call did. */
export interface DistilReport {
  /** New candidates. */
  created: Skill[];
  /** Existing skills whose steps changed (a new version, back to `candidate`) or whose support grew. */
  updated: Skill[];
  refused: SkillRefusal[];
}

/** `ai.skills`: inspect, approve and remove what the runtime distilled. */
export interface SkillsApi {
  /** Distils candidates from the agent's stored traces (replay-validated before they are stored). */
  distil(agentName: string, options?: DistilOptions): Promise<DistilReport>;
  list(agentName?: string): Promise<Skill[]>;
  get(id: string): Promise<Skill | undefined>;
  /** `candidate` -> `shadow` (advisory hint), then `shadow` -> `active` (a tool). Never automatic. */
  approve(id: string): Promise<Skill>;
  /** `candidate` or `shadow` -> `rejected`. */
  reject(id: string, reason?: string): Promise<Skill>;
  /** `shadow` or `active` -> `retired`. */
  retire(id: string, reason?: string): Promise<Skill>;
  /** Restores an earlier version (its content and the status it had); the current one is kept as a previous version. */
  rollback(id: string, version: number): Promise<Skill>;
}
