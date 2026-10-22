import { createAigentError } from '../../../core/aigent-error.js';
import type { Tool } from '../../tool-types.js';
import { createCodeFindSymbol } from './code-find-symbol.js';
import { createCodeOutline } from './code-outline.js';
import { createCodeReferences } from './code-references.js';
import { resolveCodeDeps } from './code-shared.js';
import type { CodeToolsOptions } from './code-shared.js';

/**
 * The code-intelligence pack: `code_outline`, `code_find_symbol` and `code_references` over TypeScript and JavaScript,
 * answered by the TypeScript compiler (the optional peer `typescript`, version 7) from the files `options.policy`
 * lets the tools read (deny by default): nothing outside the roots is ever read or reported. Each root's program lives
 * in a compiler process until it idles (`idleCloseMs`) or a tool's `dispose()` (called by `ai.close()`) closes it.
 */
export function codeTools(options: CodeToolsOptions): Tool[] {
  if (typeof options?.policy?.check !== 'function') {
    throw createAigentError({ code: 'invalid_definition', message: 'codeTools needs a policy from createFsPolicy({ roots })', details: { option: 'policy' } });
  }
  const deps = resolveCodeDeps({ options });
  // The three tools share one program cache: disposing any of them closes its compiler processes.
  const dispose = (): Promise<void> => deps.programs.dispose();
  return [createCodeOutline(deps), createCodeFindSymbol(deps), createCodeReferences(deps)].map(tool => ({ ...tool, dispose }));
}
