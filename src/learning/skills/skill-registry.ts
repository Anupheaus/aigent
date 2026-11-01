import { createAigentError } from '../../core/aigent-error.js';
import { canonicalJson } from '../../core/canonical-json.js';
import type { Clock, IdGenerator } from '../../core/runtime-services.js';
import type { RunTrace } from '../../telemetry/run-record.js';
import type { Tool } from '../../tools/tool-types.js';
import { checkLearnedText } from '../learned-text.js';
import { distilSkills } from './distil.js';
import { evaluateSkillUse } from './skill-health.js';
import type { SkillOptions } from './skill-health.js';
import type { SkillRecords } from './skill-store.js';
import type { DistilReport, Skill, SkillCandidate, SkillRefusal, SkillsApi, SkillStatus } from './skill-types.js';
import { validateSkill } from './validate-skill.js';

export interface CreateSkillRegistryParams {
  records: SkillRecords;
  clock: Clock;
  ids: IdGenerator;
  redactsPii: boolean;
  readTraces(): Promise<RunTrace[]>;
  agentTools(agentName: string): Tool[] | undefined;
  options?: SkillOptions;
}

/** What a run of a skills agent uses: active skills as tools, shadow ones as hints. Sorted by name. */
export interface PreparedSkills {
  active: Skill[];
  shadow: Skill[];
}

export interface SkillRegistry {
  api: SkillsApi;
  /** Retires degraded skills, then gives the agent's active and shadow skills. */
  prepareRun(agentName: string): Promise<PreparedSkills>;
}

const byName = (left: Skill, right: Skill): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
const contentKey = (skill: Pick<Skill, 'steps' | 'argsSchema'>): string => canonicalJson({ steps: skill.steps, argsSchema: skill.argsSchema });

export function createSkillRegistry(params: CreateSkillRegistryParams): SkillRegistry {
  const { records, clock, ids, redactsPii, readTraces, agentTools, options } = params;

  const required = async (id: string): Promise<Skill> => {
    const skill = await records.get(id);
    if (skill == null) throw createAigentError({ code: 'invalid_input', message: `Unknown skill '${id}'`, details: { id } });
    return skill;
  };

  const transition = async (params: { id: string; to: SkillStatus; from: SkillStatus[]; reason: string }): Promise<Skill> => {
    const { id, to, from, reason } = params;
    const skill = await required(id);
    if (!from.includes(skill.status)) throw createAigentError({ code: 'invalid_input', message: `Skill '${id}' is '${skill.status}'; it can become '${to}' only from ${from.join(' or ')}`, details: { id, status: skill.status } });
    const updated = await records.update(id, current => ({ status: to, history: [...current.history, { at: clock.now(), version: current.version, status: to, reason }] }));
    return updated ?? skill;
  };

  const ownSkills = async (agentName: string): Promise<Skill[]> => (await records.list()).filter(skill => skill.agentName === agentName).sort(byName);

  /** Stores a validated candidate: new, a new version of a changed skill, or more support for an unchanged one. */
  const store = async (params: { agentName: string; candidate: SkillCandidate; report: DistilReport }): Promise<void> => {
    const { agentName, candidate, report } = params;
    const existing = (await ownSkills(agentName)).find(({ name }) => name === candidate.name);
    const now = clock.now();
    if (existing == null) {
      const skill: Skill = { ...candidate, id: ids.next('skill'), version: 1, status: 'candidate', createdAt: now, history: [{ at: now, version: 1, status: 'candidate', reason: 'distilled' }], previousVersions: [] };
      await records.create(skill);
      report.created.push((await records.get(skill.id)) ?? skill);
      return;
    }
    const isChanged = contentKey(existing) !== contentKey(candidate);
    if (!isChanged && canonicalJson(existing.supportingRunIds) === canonicalJson(candidate.supportingRunIds)) return;
    const updated = await records.update(existing.id, current => (isChanged
      ? {
        ...candidate, version: current.version + 1, status: 'candidate', stats: { ...candidate.stats, uses: 0, successRate: 0 },
        previousVersions: [...current.previousVersions, { version: current.version, status: current.status, description: current.description, argsSchema: current.argsSchema, steps: current.steps, preconditions: current.preconditions, examples: current.examples }],
        history: [...current.history, { at: now, version: current.version + 1, status: 'candidate', reason: 'distilled again with changed steps; needs approval again' }],
      }
      : { supportingRunIds: candidate.supportingRunIds, stats: { ...current.stats, supportingRuns: candidate.stats.supportingRuns } }));
    if (updated != null) report.updated.push(updated);
  };

  const evaluate = async (agentName: string): Promise<Skill[]> => {
    const skills = await ownSkills(agentName);
    if (!skills.some(({ status }) => status === 'active')) return skills;
    const traces = (await readTraces()).filter(({ run }) => run.agentName === agentName);
    for (const skill of skills.filter(({ status }) => status === 'active')) {
      const health = evaluateSkillUse({ skill, traces, ...(options == null ? {} : { options }) });
      if (health.retire != null) await transition({ id: skill.id, to: 'retired', from: ['active'], reason: health.retire });
      else if (health.uses !== skill.stats.uses) await records.update(skill.id, current => ({ stats: { ...current.stats, uses: health.uses, successRate: health.successRate } }));
    }
    return ownSkills(agentName);
  };

  const api: SkillsApi = {
    distil: async (agentName, distilOptions = {}) => {
      const tools = agentTools(agentName);
      if (tools == null) throw createAigentError({ code: 'invalid_input', message: `Unknown agent '${agentName}': define it with ai.agent first, so its tools are known`, details: { agentName } });
      const traces = (await readTraces()).filter(({ run }) => run.agentName === agentName);
      const refused: SkillRefusal[] = [];
      const candidates = distilSkills({ traces, tools, agentName, ...distilOptions, onRefused: refusal => refused.push(refusal) });
      const report: DistilReport = { created: [], updated: [], refused };
      for (const candidate of candidates) {
        const tools = candidate.steps.map(({ tool }) => tool);
        const { replayPass, failures } = validateSkill(candidate, traces);
        if (replayPass < 1) { refused.push({ tools, reason: `the replay did not reproduce every supporting run: ${failures.map(({ runId, reason }) => `${runId}: ${reason}`).join('; ')}` }); continue; }
        const checked = checkLearnedText({ text: candidate.description, redactsPii });
        if (checked.injection.length > 0 || checked.text !== candidate.description) { refused.push({ tools, reason: 'its description is not safe to show' }); continue; }
        await store({ agentName, candidate: { ...candidate, stats: { ...candidate.stats, replayPass } }, report });
      }
      return report;
    },
    list: async agentName => (agentName == null ? (await records.list()).sort(byName) : ownSkills(agentName)),
    get: id => records.get(id),
    approve: async id => {
      const skill = await required(id);
      if (skill.status === 'candidate') return transition({ id, to: 'shadow', from: ['candidate'], reason: 'approved as a hint (shadow)' });
      return transition({ id, to: 'active', from: ['shadow'], reason: 'approved as a tool (active)' });
    },
    reject: (id, reason = 'rejected by the consumer') => transition({ id, to: 'rejected', from: ['candidate', 'shadow'], reason }),
    retire: (id, reason = 'retired by the consumer') => transition({ id, to: 'retired', from: ['shadow', 'active'], reason }),
    rollback: async (id, version) => {
      const skill = await required(id);
      const target = skill.previousVersions.find(snapshot => snapshot.version === version);
      if (target == null) throw createAigentError({ code: 'invalid_input', message: `Skill '${id}' has no earlier version ${version} (earlier versions: ${skill.previousVersions.map(snapshot => snapshot.version).join(', ') || 'none'})`, details: { id, version } });
      const updated = await records.update(id, current => ({
        ...target,
        previousVersions: [...current.previousVersions.filter(snapshot => snapshot.version !== version), { version: current.version, status: current.status, description: current.description, argsSchema: current.argsSchema, steps: current.steps, preconditions: current.preconditions, examples: current.examples }],
        history: [...current.history, { at: clock.now(), version, status: target.status, reason: `rolled back from version ${current.version}` }],
      }));
      return updated ?? skill;
    },
  };

  return {
    api,
    prepareRun: async agentName => {
      const skills = await evaluate(agentName);
      return { active: skills.filter(({ status }) => status === 'active'), shadow: skills.filter(({ status }) => status === 'shadow') };
    },
  };
}
