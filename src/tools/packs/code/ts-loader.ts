import { toolFailure } from '../../tool-failure.js';
import type { TsApi, TsFileSystem, TsModules } from './ts-api.js';

/** The optional peer the code tools need: TypeScript 7 with its `unstable/sync` API (a native compiler process). */
const SYNC_API = 'typescript/unstable/sync';
const AST_API = 'typescript/unstable/ast';
const INSTALL_HINT = 'Install the optional peer dependency: npm install -D typescript@^7';

interface SyncModule {
  API: new (options: { cwd: string; fs: TsFileSystem }) => TsApi;
}

interface AstModule {
  SyntaxKind: Readonly<Record<string, number | string>>;
}

/** Loads a module by a name the type checker does not resolve, so the pack builds without `typescript` installed. */
async function importOptional(specifier: string): Promise<unknown> {
  return import(specifier) as Promise<unknown>;
}

/** The code tools' failure when TypeScript is missing or too old: says exactly what to install. */
export function typescriptUnavailable(error: unknown): Error {
  return toolFailure({
    code: 'typescript_unavailable', retryable: false, suggestion: `${INSTALL_HINT}; until then use fs_search to find code`,
    message: `The code tools need TypeScript 7 (${SYNC_API}), which could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
  });
}

/** Imports TypeScript's API on first use; throws `typescript_unavailable` when it is not installed (or is not TypeScript 7). */
export async function loadTypeScript(): Promise<TsModules> {
  let sync: SyncModule;
  let ast: AstModule;
  try {
    [sync, ast] = await Promise.all([importOptional(SYNC_API) as Promise<SyncModule>, importOptional(AST_API) as Promise<AstModule>]);
  } catch (error) {
    throw typescriptUnavailable(error);
  }
  if (typeof sync?.API !== 'function' || typeof ast?.SyntaxKind !== 'object') throw typescriptUnavailable(new Error('its API has an unexpected shape'));
  return { createApi: ({ cwd, fs }) => new sync.API({ cwd, fs }), syntaxKind: ast.SyntaxKind };
}
