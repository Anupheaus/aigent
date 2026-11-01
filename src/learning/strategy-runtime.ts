import { createAigentError } from '../core/aigent-error.js';
import { describeError } from '../core/describe-value.js';
import type { Clock, IdGenerator } from '../core/runtime-services.js';
import type { UserFeedback } from '../feedback/feedback-records.js';
import type { Finding } from '../scoring/report-types.js';
import type { RunRecord, RunTrace } from '../telemetry/run-record.js';
import type { Tool } from '../tools/tool-types.js';
import { buildGroupLessons } from './lessons.js';
import type { GroupLesson } from './lessons.js';
import { evaluateActive, evaluateTrial } from './rollout-guard.js';
import { resolveStrategyOptions } from './strategy-options.js';
import { changesKey, validateProposal } from './strategy-store.js';
import type { StrategyRecords } from './strategy-store.js';
import type { ProposedVariant, RunStrategyRecord, StrategyApi, StrategyOptions, StrategyVariant, VariantStatus } from './strategy-types.js';
import { suggestVariants } from './suggest-variants.js';
import { selectVariants } from './variant-selector.js';

export interface CreateStrategyRuntimeParams {
  options?: StrategyOptions;
  records: StrategyRecords;
  clock: Clock;
  ids: IdGenerator;
  redactsPii: boolean;
  readRuns(): Promise<RunRecord[]>;
  readTraces(): Promise<RunTrace[]>;
  /** User ratings by response id. */
  readRatings(): Promise<Map<string, UserFeedback>>;
  findings(agentName: string): Promise<Finding[]>;
  /** The tools of an agent defined in this runtime (undefined for an unknown agent). */
  agentTools(agentName: string): Tool[] | undefined;
  /** Saves one lesson to the agent's memory; undefined when the agent has no memory here. */
  saveLesson?(params: { agentName: string; lesson: GroupLesson }): Promise<string | undefined>;
}

/** What a run of a strategy agent uses. */
export interface PreparedStrategy {
  record: RunStrategyRecord;
  applied: StrategyVariant[];
}

export interface StrategyRuntime {
  api: StrategyApi;
  /** Runs the guard for the agent, then picks the run's variants. */
  prepareRun(params: { agentName: string; runId: string; bucket: string }): Promise<PreparedStrategy>;
}

export function createStrategyRuntime(params: CreateStrategyRuntimeParams): StrategyRuntime {
  const { records, clock, ids, redactsPii, readRuns, agentTools } = params;
  const options = resolveStrategyOptions(params.options);
  /** Transitions of one agent run one at a time, so two run starts never promote or revert the same variant twice. */
  const chains = new Map<string, Promise<unknown>>();
  const serialised = <T>(agentName: string, work: () => Promise<T>): Promise<T> => {
    const next = (chains.get(agentName) ?? Promise.resolve()).then(work, work);
    chains.set(agentName, next.catch(() => undefined));
    return next;
  };

  const required = async (id: string): Promise<StrategyVariant> => {
    const variant = await records.get(id);
    if (variant == null) throw createAigentError({ code: 'invalid_input', message: `Unknown strategy variant '${id}'`, details: { id } });
    return variant;
  };

  const transition = async (params: { variant: StrategyVariant; to: VariantStatus; from: VariantStatus[]; reason: string; evidence?: Record<string, unknown>; extra?: Partial<StrategyVariant> }): Promise<StrategyVariant> => {
    const { variant, to, from, reason, evidence, extra = {} } = params;
    if (!from.includes(variant.status)) throw createAigentError({ code: 'invalid_input', message: `Strategy variant '${variant.id}' is '${variant.status}'; it can become '${to}' only from ${from.join(' or ')}`, details: { id: variant.id, status: variant.status } });
    const event = { at: clock.now(), status: to, reason, ...(evidence == null ? {} : { evidence }) };
    const updated = await records.update(variant.id, current => ({ status: to, history: [...current.history, event], ...extra }));
    if (updated == null) throw createAigentError({ code: 'invalid_input', message: `Strategy variant '${variant.id}' was removed`, details: { id: variant.id } });
    return updated;
  };

  const ownVariants = async (agentName: string): Promise<StrategyVariant[]> => (await records.list()).filter(variant => variant.agentName === agentName).sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : 1));

  const create = async (params: { agentName: string; proposal: ProposedVariant; createdBy: StrategyVariant['createdBy']; source?: string }): Promise<StrategyVariant> => {
    const { agentName, proposal, createdBy, source } = params;
    const tools = agentTools(agentName);
    const checked = validateProposal({ agentName, proposal, redactsPii, ...(tools == null ? {} : { toolNames: tools.map(({ name }) => name) }) });
    const existing = (await ownVariants(agentName)).find(variant => changesKey(variant.changes) === changesKey(checked.changes));
    if (existing != null) return existing;
    const now = clock.now();
    const variant: StrategyVariant = {
      id: ids.next('variant'), agentName, label: checked.label, changes: checked.changes, status: 'candidate', createdAt: now, createdBy,
      history: [{ at: now, status: 'candidate', reason: createdBy === 'consumer' ? 'proposed' : `suggested from finding '${source}'` }], ...(source == null ? {} : { source }),
    };
    await records.create(variant);
    return (await records.get(variant.id)) ?? variant;
  };

  const evaluate = (agentName: string): Promise<StrategyVariant[]> => serialised(agentName, async () => {
    const variants = await ownVariants(agentName);
    if (!variants.some(({ status }) => status === 'trial' || status === 'active')) return variants;
    const runs = await readRuns();
    for (const variant of variants) {
      if (variant.status === 'trial') {
        const verdict = evaluateTrial({ variant, runs, options });
        const evidence = { ...verdict.evidence };
        if (verdict.action === 'promote') await transition({ variant, to: 'active', from: ['trial'], reason: verdict.reason, evidence, extra: { promotedAt: clock.now(), baselineRate: verdict.evidence.control.rate } });
        if (verdict.action === 'reject') await transition({ variant, to: 'rejected', from: ['trial'], reason: verdict.reason, evidence });
      } else if (variant.status === 'active') {
        const verdict = evaluateActive({ variant, runs, options });
        if (verdict.action === 'revert') await transition({ variant, to: 'reverted', from: ['active'], reason: verdict.reason, evidence: { ...verdict.evidence } });
      }
    }
    return ownVariants(agentName);
  });

  const api: StrategyApi = {
    propose: (agentName, proposal) => create({ agentName, proposal, createdBy: 'consumer' }),
    suggest: async agentName => {
      const known = new Set((await ownVariants(agentName)).flatMap(({ source }) => (source == null ? [] : [source])));
      const descriptions = new Map((agentTools(agentName) ?? []).map(({ name, description }) => [name, description]));
      const { suggested, skipped } = suggestVariants({ findings: await params.findings(agentName), agentName, toolDescriptions: descriptions });
      const created: StrategyVariant[] = [];
      for (const { source, proposal } of suggested.filter(({ source }) => !known.has(source))) {
        try {
          created.push(await create({ agentName, proposal, createdBy: 'suggested', source }));
        } catch (error) { // one suggestion that fails validation (e.g. a description grown too long) is reported, not fatal
          skipped.push({ source, reason: describeError(error) });
        }
      }
      return { created, skipped };
    },
    approve: async id => {
      const variant = await required(id);
      return serialised(variant.agentName, async () => {
        const inTrial = (await ownVariants(variant.agentName)).find(({ status, id: other }) => status === 'trial' && other !== id);
        if (inTrial != null) throw createAigentError({ code: 'invalid_input', message: `Agent '${variant.agentName}' already has variant '${inTrial.id}' in trial; finish or reject it first`, details: { id, inTrial: inTrial.id } });
        return transition({ variant: await required(id), to: 'trial', from: ['candidate'], reason: 'approved for trial', extra: { trialStartedAt: clock.now() } });
      });
    },
    reject: async (id, reason = 'rejected by the consumer') => { const variant = await required(id); return serialised(variant.agentName, async () => transition({ variant: await required(id), to: 'rejected', from: ['candidate', 'trial'], reason })); },
    revert: async (id, reason = 'reverted by the consumer') => { const variant = await required(id); return serialised(variant.agentName, async () => transition({ variant: await required(id), to: 'reverted', from: ['active'], reason })); },
    remove: id => records.remove(id),
    get: id => records.get(id),
    list: async agentName => (agentName == null ? (await records.list()).sort((left, right) => left.createdAt - right.createdAt) : ownVariants(agentName)),
    evaluate,
    lessons: async agentName => {
      if (params.saveLesson == null) return { saved: 0, problems: ['memory needs a store'] };
      const [traces, ratings] = await Promise.all([params.readTraces(), params.readRatings()]);
      const lessons = buildGroupLessons({ traces: traces.filter(({ run }) => run.agentName === agentName), ratings });
      const problems: string[] = [];
      for (const lesson of lessons) { const problem = await params.saveLesson({ agentName, lesson }); if (problem != null) problems.push(problem); }
      return { saved: lessons.length - problems.length, problems };
    },
  };

  return {
    api,
    prepareRun: async ({ agentName, runId, bucket }) => {
      const variants = await evaluate(agentName);
      const selected = selectVariants({ variants, agentName, runKey: runId, seed: options.seed, trialShare: options.trialShare });
      const record: RunStrategyRecord = { bucket, arm: selected.arm, activeVariantIds: selected.active.map(({ id }) => id), ...(selected.trial == null ? {} : { trialVariantId: selected.trial.id }) };
      return { record, applied: selected.applied };
    },
  };
}
