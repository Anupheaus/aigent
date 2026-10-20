import { createAigentError } from '../../../core/aigent-error.js';
import type { Tool } from '../../tool-types.js';
import { createShellRun } from './shell-run.js';
import { resolveShellDeps } from './shell-shared.js';
import type { ShellToolsOptions } from './shell-shared.js';

/**
 * The shell pack: `shell_run`, every command through `options.policy` (deny by default: exact allowed names, argv
 * arrays, checked working directories, scrubbed environments) and every process through `options.runner`.
 */
export function shellTools(options: ShellToolsOptions): Tool[] {
  if (typeof options?.policy?.checkCommand !== 'function') {
    throw createAigentError({ code: 'invalid_definition', message: 'shellTools needs a policy from createShellPolicy({ commands, cwdPolicy })', details: { option: 'policy' } });
  }
  return [createShellRun(resolveShellDeps(options))];
}
