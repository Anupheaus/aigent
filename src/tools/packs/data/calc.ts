import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool } from '../../tool-types.js';
import { evaluateExpression } from '../expression.js';
import { DATA_TOOL_BASE, guarded } from './data-shared.js';

export const CALC_TOOL_NAME = 'calc';

const calcItem = z.object({
  expression: z.string().min(1).describe('Arithmetic: + - * / % ^, parentheses, min max abs round floor ceil sqrt pow log, constants pi and e'),
}).strict();

/** `calc`: exact arithmetic through a small parser (nothing is evaluated as code). */
export function createCalc(): Tool {
  return defineBatchTool({
    ...DATA_TOOL_BASE,
    name: CALC_TOOL_NAME,
    description: 'Evaluate arithmetic expressions exactly; errors name the problem (division by zero, unknown name, syntax).',
    item: calcItem, contentKind: 'structured-data', fidelity: 'verbatim',
    describeActivity: ({ items }) => ({ title: items.length === 1 ? 'Calculating' : `Running ${items.length} calculations` }),
    runItem: async ({ expression }) => ({ value: guarded(() => evaluateExpression(expression)) }),
  });
}
