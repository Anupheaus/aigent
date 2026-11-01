import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { canonicalJson } from '../core/canonical-json.js';
import { describeIssues } from '../core/describe-issues.js';
import { createLearnedRecords } from './learned-records.js';
import type { CreateLearnedRecordsParams, LearnedRecords } from './learned-records.js';
import { checkLearnedText } from './learned-text.js';
import type { ProposedVariant, StrategyVariant, VariantChange } from './strategy-types.js';

/** Store collection of strategy variants, keyed by variant id. */
export const STRATEGY_COLLECTION = 'strategy';
export const MAX_RULE_LENGTH = 400;
export const MAX_TOOL_DESCRIPTION_LENGTH = 1_024;
const MAX_CHANGES = 10;
const MAX_ORDERED_TOOLS = 20;
const MAX_LABEL_LENGTH = 120;
const toolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const changeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool-description'), tool: toolName, text: z.string().min(1).max(MAX_TOOL_DESCRIPTION_LENGTH) }).strict(),
  z.object({ kind: z.literal('system-rule'), text: z.string().min(1).max(MAX_RULE_LENGTH), position: z.literal('after-rules') }).strict(),
  z.object({ kind: z.literal('tool-order-hint'), tools: z.array(toolName).min(1).max(MAX_ORDERED_TOOLS) }).strict(),
  z.object({ kind: z.literal('batching-hint'), text: z.string().min(1).max(MAX_RULE_LENGTH) }).strict(),
]);
const proposalSchema = z.object({ label: z.string().min(1).max(MAX_LABEL_LENGTH), changes: z.array(changeSchema).min(1).max(MAX_CHANGES) }).strict();
const statusSchema = z.enum(['candidate', 'trial', 'active', 'rejected', 'reverted']);
const variantSchema = z.object({
  id: z.string().min(1), agentName: z.string().min(1), label: z.string(), changes: z.array(changeSchema), status: statusSchema, createdAt: z.number(),
  createdBy: z.enum(['consumer', 'suggested']),
  history: z.array(z.object({ at: z.number(), status: statusSchema, reason: z.string(), evidence: z.record(z.string(), z.unknown()).optional() })),
  trialStartedAt: z.number().optional(), promotedAt: z.number().optional(), baselineRate: z.number().optional(), source: z.string().optional(),
});

/** The texts of a change that reach the prompt. */
export function changeTexts(change: VariantChange): string[] {
  switch (change.kind) {
    case 'tool-order-hint': return [];
    default: return [change.text];
  }
}

function withText(change: VariantChange, text: string): VariantChange {
  return change.kind === 'tool-order-hint' ? change : { ...change, text };
}

/**
 * A proposal validated (shape, lengths, known tools) and scrubbed of secrets; instruction-like text is refused, since
 * a variant's text goes straight into the system prompt. Throws `invalid_input` naming the problem.
 */
export function validateProposal(params: { agentName: string; proposal: unknown; toolNames?: string[]; redactsPii: boolean }): ProposedVariant {
  const { agentName, proposal, toolNames, redactsPii } = params;
  const parsed = proposalSchema.safeParse(proposal);
  if (!parsed.success) throw createAigentError({ code: 'invalid_input', message: `Invalid strategy variant for agent '${agentName}': ${describeIssues(parsed.error)}`, details: { agentName } });
  const changes = parsed.data.changes.map(change => {
    const tools = change.kind === 'tool-description' ? [change.tool] : change.kind === 'tool-order-hint' ? change.tools : [];
    const unknown = toolNames == null ? [] : tools.filter(tool => !toolNames.includes(tool));
    if (unknown.length > 0) throw createAigentError({ code: 'invalid_input', message: `Strategy variant for agent '${agentName}' names tools it does not have: ${unknown.join(', ')} (known: ${toolNames?.join(', ')})`, details: { agentName, tools: unknown } });
    const [text] = changeTexts(change);
    if (text == null) return change;
    const checked = checkLearnedText({ text, redactsPii });
    if (checked.injection.length > 0) throw createAigentError({ code: 'invalid_input', message: `Strategy variant for agent '${agentName}' holds instruction-like text (${checked.injection.join(', ')}); variant text must be plain advice`, details: { agentName, kinds: checked.injection } });
    return withText(change, checked.text);
  });
  return { label: parsed.data.label, changes };
}

/** The same changes, whatever their order: used to find an existing identical variant. */
export function changesKey(changes: VariantChange[]): string {
  return canonicalJson([...changes].map(change => canonicalJson(change)).sort());
}

/** The runtime's strategy variants (in its store, or in memory without one). */
export type StrategyRecords = LearnedRecords<StrategyVariant>;

export function createStrategyRecords(params: Omit<CreateLearnedRecordsParams<StrategyVariant>, 'collection' | 'queueKey' | 'parse'>): StrategyRecords {
  return createLearnedRecords<StrategyVariant>({
    ...params, collection: STRATEGY_COLLECTION, queueKey: `learning:${STRATEGY_COLLECTION}`,
    parse: value => { const parsed = variantSchema.safeParse(value); return parsed.success ? parsed.data as StrategyVariant : undefined; },
  });
}
