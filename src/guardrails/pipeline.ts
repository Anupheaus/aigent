import type { Guardrail, GuardrailDecision, GuardrailDecisionRecord, GuardrailStage, GuardrailValue } from './guardrail-types.js';

/** Default longest time one check may take. */
export const DEFAULT_GUARDRAIL_TIMEOUT_MS = 2_000;

/** The pipeline's verdict: the (possibly rewritten) value, or the block that stopped it. */
export type PipelineResult =
  | { action: 'allow'; value: GuardrailValue }
  | { action: 'block'; guardrail: string; reason: string; code: string; value: GuardrailValue };

export interface PipelineRunParams {
  stage: GuardrailStage;
  value: GuardrailValue;
  context: { runId: string; agentName: string; callId?: string };
}

export interface GuardrailPipeline {
  has(stage: GuardrailStage): boolean;
  /** Synchronous while every check of the stage is (so tool calls keep their start order); a promise otherwise. */
  run(params: PipelineRunParams): PipelineResult | Promise<PipelineResult>;
}

export interface CreateGuardrailPipelineParams {
  /** In their fixed order; they run first. */
  builtins?: Guardrail[];
  custom?: Guardrail[];
  failMode?: 'closed' | 'open';
  timeoutMs?: number;
  /** Every non-allow decision (and warning), as it happens. */
  onDecision(record: GuardrailDecisionRecord): void;
}

type Outcome = GuardrailDecision | { action: 'error'; code: 'guardrail_error' | 'guardrail_timeout'; message: string };

const ACTIONS: ReadonlySet<unknown> = new Set(['allow', 'rewrite', 'block']);

function isDecision(value: unknown): value is GuardrailDecision {
  if (typeof value !== 'object' || value === null || !ACTIONS.has((value as { action?: unknown }).action)) return false;
  const decision = value as GuardrailDecision;
  if (decision.action === 'block') return typeof decision.reason === 'string' && typeof decision.code === 'string';
  if (decision.action === 'rewrite') return typeof decision.note === 'string';
  return true;
}

function errorOutcome(error: unknown): Outcome {
  return { action: 'error', code: 'guardrail_error', message: `The check failed: ${error instanceof Error ? error.message : String(error)}` };
}

function checked(value: unknown): Outcome {
  return isDecision(value) ? value : { action: 'error', code: 'guardrail_error', message: `The check returned no valid decision: ${JSON.stringify(value)}` };
}

/** Settles with the decision, or a timeout outcome after `timeoutMs`; never leaves its timer behind. */
function bounded(params: { pending: Promise<unknown>; timeoutMs: number }): Promise<Outcome> {
  const { pending, timeoutMs } = params;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome>(resolve => {
    timer = setTimeout(() => resolve({ action: 'error', code: 'guardrail_timeout', message: `The check took longer than ${timeoutMs} ms` }), timeoutMs);
  });
  return Promise.race([pending.then(checked, errorOutcome), timeout]).finally(() => clearTimeout(timer));
}

/** Custom guardrails by `order` (default 0), registration order breaking ties. */
function ordered(custom: Guardrail[]): Guardrail[] {
  return custom.map((guardrail, index) => ({ guardrail, index })).sort((left, right) => (left.guardrail.order ?? 0) - (right.guardrail.order ?? 0) || left.index - right.index).map(({ guardrail }) => guardrail);
}

/** Runs a stage's guardrails in order: rewrites chain, the first block stops it, failing checks fail closed or open. */
export function createGuardrailPipeline(params: CreateGuardrailPipelineParams): GuardrailPipeline {
  const { builtins = [], custom = [], failMode = 'closed', timeoutMs = DEFAULT_GUARDRAIL_TIMEOUT_MS, onDecision } = params;
  const all = [...builtins, ...ordered(custom)];

  function run(runParams: PipelineRunParams): PipelineResult | Promise<PipelineResult> {
    const { stage, context } = runParams;
    const guardrails = all.filter(guardrail => guardrail.stage === stage);
    const base = { stage, ...(context.callId == null ? {} : { callId: context.callId }) };

    /** Applies one outcome; a result when the pipeline is done, else the value to continue with. */
    const apply = (guardrail: Guardrail, outcome: Outcome, value: GuardrailValue): { result?: PipelineResult; value: GuardrailValue } => {
      const { name } = guardrail;
      if (outcome.action === 'allow') return { value };
      if (outcome.action === 'rewrite') {
        onDecision({ guardrail: name, ...base, action: 'rewrite', message: outcome.note });
        return { value: outcome.value as GuardrailValue };
      }
      if (outcome.action === 'block') {
        onDecision({ guardrail: name, ...base, action: 'block', code: outcome.code, message: outcome.reason });
        return { value, result: { action: 'block', guardrail: name, reason: outcome.reason, code: outcome.code, value } };
      }
      const isBlocking = guardrail.blockLevel === true || failMode === 'closed';
      onDecision({ guardrail: name, ...base, action: 'error', code: outcome.code, message: outcome.message, isBlocking });
      return isBlocking ? { value, result: { action: 'block', guardrail: name, reason: outcome.message, code: outcome.code, value } } : { value };
    };

    const runFrom = (start: number, initial: GuardrailValue): PipelineResult | Promise<PipelineResult> => {
      let value = initial;
      for (let position = start; position < guardrails.length; position += 1) {
        const guardrail = guardrails[position] as Guardrail;
        const warn = (message: string): void => onDecision({ guardrail: guardrail.name, ...base, action: 'warn', message });
        let raw: unknown;
        try {
          raw = guardrail.check(value, { ...context, stage, warn });
        } catch (error) {
          raw = Promise.reject(error);
        }
        if (raw instanceof Promise) {
          const current = value;
          return bounded({ pending: raw, timeoutMs }).then(outcome => {
            const applied = apply(guardrail, outcome, current);
            return applied.result ?? runFrom(position + 1, applied.value);
          });
        }
        const applied = apply(guardrail, checked(raw), value);
        if (applied.result != null) return applied.result;
        value = applied.value;
      }
      return { action: 'allow', value };
    };

    return runFrom(0, runParams.value);
  }

  return { has: stage => all.some(guardrail => guardrail.stage === stage), run };
}
