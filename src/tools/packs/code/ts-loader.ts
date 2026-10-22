import { toolFailure } from '../../tool-failure.js';
import type { TsApi, TsFileSystem, TsModules, TsSnapshot } from './ts-api.js';

/** The optional peer the code tools need: TypeScript 7 with its `unstable/async` API (a native compiler process). */
const ASYNC_API = 'typescript/unstable/async';
const AST_API = 'typescript/unstable/ast';
const INSTALL_HINT = 'Install the optional peer dependency: npm install -D typescript@^7';

/** TypeScript's API object as the pack uses it. */
interface AsyncApi {
  updateSnapshot(params: { openProjects: string[] }): Promise<TsSnapshot>;
  close(): Promise<void>;
}

interface AsyncModule {
  API: new (options: { cwd: string; fs: TsFileSystem }) => AsyncApi;
}

interface AstModule {
  SyntaxKind: Readonly<Record<string, number | string>>;
}

/** A handle Node can stop waiting for (a child process or one of its pipes). */
interface Unrefable {
  unref?(): void;
}

/** The compiler's child process and pipes as TypeScript's client holds them (private fields, so each may be absent). */
interface ClientInternals {
  client?: { process?: Unrefable & { stdin?: Unrefable | null; stdout?: Unrefable | null } };
}

/** Loads a module by a name the type checker does not resolve, so the pack builds without `typescript` installed. */
async function importOptional(specifier: string): Promise<unknown> {
  return import(specifier) as Promise<unknown>;
}

/** The code tools' failure when TypeScript is missing or too old: says exactly what to install. */
export function typescriptUnavailable(error: unknown): Error {
  return toolFailure({
    code: 'typescript_unavailable', retryable: false, suggestion: `${INSTALL_HINT}; until then use fs_search to find code`,
    message: `The code tools need TypeScript 7 (${ASYNC_API}), which could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
  });
}

/**
 * Lets Node exit while the compiler idles: its process and pipes stop holding the event loop open. TypeScript keeps
 * them private, so a client whose fields moved is left as it is (it then lives until `close`).
 */
function detachProcess(api: AsyncApi): void {
  const child = (api as unknown as ClientInternals).client?.process;
  child?.unref?.();
  child?.stdin?.unref?.();
  child?.stdout?.unref?.();
}

/** Imports TypeScript's API on first use; throws `typescript_unavailable` when it is not installed (or is not TypeScript 7). */
export async function loadTypeScript(): Promise<TsModules> {
  let api: AsyncModule;
  let ast: AstModule;
  try {
    [api, ast] = await Promise.all([importOptional(ASYNC_API) as Promise<AsyncModule>, importOptional(AST_API) as Promise<AstModule>]);
  } catch (error) {
    throw typescriptUnavailable(error);
  }
  if (typeof api?.API !== 'function' || typeof ast?.SyntaxKind !== 'object') throw typescriptUnavailable(new Error('its API has an unexpected shape'));
  return {
    createApi: ({ cwd, fs }): TsApi => {
      const instance = new api.API({ cwd, fs });
      return { updateSnapshot: params => instance.updateSnapshot(params), close: () => instance.close(), detach: () => detachProcess(instance) };
    },
    syntaxKind: ast.SyntaxKind,
  };
}
