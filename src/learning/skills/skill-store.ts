import { z } from 'zod';
import { createLearnedRecords } from '../learned-records.js';
import type { CreateLearnedRecordsParams, LearnedRecords } from '../learned-records.js';
import type { Skill } from './skill-types.js';

/** Store collection of learned skills, keyed by skill id. */
export const SKILLS_COLLECTION = 'skills';

const statusSchema = z.enum(['candidate', 'shadow', 'active', 'rejected', 'retired']);
const templateSchema = z.union([
  z.object({ const: z.unknown() }).strict(),
  z.object({ param: z.string().min(1) }).strict(),
  z.object({ fromStep: z.number().int().nonnegative(), path: z.string() }).strict(),
]);
const stepSchema = z.object({ tool: z.string().min(1), args: z.record(z.string(), templateSchema), onFailure: z.enum(['stop', 'continue']) });
const contentShape = {
  description: z.string(), argsSchema: z.record(z.string(), z.unknown()), steps: z.array(stepSchema).min(1), preconditions: z.array(z.string()),
  examples: z.array(z.object({ args: z.record(z.string(), z.unknown()), summary: z.string() })),
};
const skillSchema = z.object({
  id: z.string().min(1), name: z.string().regex(/^skill_[a-z0-9_]{1,58}$/), version: z.number().int().positive(), ...contentShape,
  stats: z.object({ supportingRuns: z.number(), replayPass: z.number(), uses: z.number(), successRate: z.number() }),
  status: statusSchema, createdAt: z.number(), agentName: z.string().min(1), allowSideEffects: z.boolean().optional(), supportingRunIds: z.array(z.string()),
  history: z.array(z.object({ at: z.number(), version: z.number(), status: statusSchema, reason: z.string() })),
  previousVersions: z.array(z.object({ version: z.number().int().positive(), status: statusSchema, ...contentShape })),
});

/** The runtime's skills (in its store through `redact`, or in memory without one). */
export type SkillRecords = LearnedRecords<Skill>;

export function createSkillRecords(params: Omit<CreateLearnedRecordsParams<Skill>, 'collection' | 'queueKey' | 'parse'>): SkillRecords {
  return createLearnedRecords<Skill>({
    ...params, collection: SKILLS_COLLECTION, queueKey: `learning:${SKILLS_COLLECTION}`,
    // A stored skill that no longer matches the schema (a corrupt or tampered record) is never loaded, so never run.
    parse: value => { const parsed = skillSchema.safeParse(value); return parsed.success ? parsed.data as Skill : undefined; },
  });
}
