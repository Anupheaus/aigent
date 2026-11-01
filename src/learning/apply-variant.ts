import type { Tool } from '../tools/tool-types.js';
import { isSafeToShow } from './learned-text.js';
import type { StrategyVariant, VariantChange } from './strategy-types.js';

const STRATEGY_HEADING = '# Strategy';

/** What a run's variants add to its prompt, as deterministic, byte-stable text. */
export interface VariantOverlay {
  /** Sorted, unique. */
  rules: string[];
  /** Replacement descriptions by tool name. */
  toolDescriptions: Map<string, string>;
  /** Changes left out because their stored text is no longer safe to show (it was changed in the store). */
  skipped: string[];
}

function ruleOf(change: VariantChange): string | undefined {
  switch (change.kind) {
    case 'system-rule': return change.text;
    case 'batching-hint': return `Batching: ${change.text}`;
    case 'tool-order-hint': return `Prefer these tools, in this order: ${change.tools.join(', ')}.`;
    default: return undefined;
  }
}

/**
 * The overlay of the given variants, applied in id order (a later variant's description of the same tool wins). Each
 * stored text is checked again before it is shown, and an unsafe one is skipped and reported.
 */
export function buildOverlay(params: { variants: StrategyVariant[]; redactsPii: boolean }): VariantOverlay {
  const { variants, redactsPii } = params;
  const rules = new Set<string>();
  const toolDescriptions = new Map<string, string>();
  const skipped: string[] = [];
  for (const { id, changes } of [...variants].sort((left, right) => (left.id < right.id ? -1 : 1))) {
    for (const change of changes) {
      const text = change.kind === 'tool-description' ? change.text : ruleOf(change);
      if (text == null) continue;
      if (!isSafeToShow({ text, redactsPii })) { skipped.push(`Variant '${id}' has a ${change.kind} whose stored text holds a secret or instruction-like text; it was not applied`); continue; }
      if (change.kind === 'tool-description') toolDescriptions.set(change.tool, change.text); else rules.add(text);
    }
  }
  return { rules: [...rules].sort(), toolDescriptions, skipped };
}

/** The `# Strategy` section of the system prompt, or undefined when there are no rules. */
export function strategySection(rules: string[]): string | undefined {
  return rules.length === 0 ? undefined : `${STRATEGY_HEADING}\n${rules.map(rule => `- ${rule}`).join('\n')}`;
}

/** The tools with the overlay's descriptions; tools without one are passed through untouched. */
export function applyToolOverlay(params: { tools: Tool[]; overlay: VariantOverlay }): Tool[] {
  const { tools, overlay: { toolDescriptions } } = params;
  if (toolDescriptions.size === 0) return tools;
  return tools.map(tool => { const description = toolDescriptions.get(tool.name); return description == null ? tool : { ...tool, description }; });
}
