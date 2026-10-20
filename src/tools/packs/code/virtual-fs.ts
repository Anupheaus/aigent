import type { TsFileSystem } from './ts-api.js';

/** A path as the compiler process spells it: forward slashes (and lower case where names compare case-insensitively). */
export function compilerKey(params: { path: string; caseSensitive: boolean }): string {
  const { path, caseSensitive } = params;
  const forward = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseSensitive ? forward : forward.toLowerCase();
}

/** TypeScript's own default libraries (`lib.es2022.d.ts`...), which the compiler reads from its package. */
function isCompilerLibrary(key: string): boolean {
  return key.includes('/@typescript/typescript-') || key.includes('/node_modules/typescript/');
}

export interface VirtualFsParams {
  /** Compiler key → file text: the only project files the compiler may see. */
  files: ReadonlyMap<string, string>;
  /** Extra files that exist only here (the generated tsconfig), by compiler key. */
  extra: ReadonlyMap<string, string>;
  caseSensitive: boolean;
}

/**
 * The compiler's view of the disk: exactly the files the policy allowed and the tools read (nothing else exists, so
 * nothing outside the roots is ever read), plus TypeScript's own default libraries from its package.
 */
export function createVirtualFs(params: VirtualFsParams): TsFileSystem {
  const { files, extra, caseSensitive } = params;
  const key = (path: string): string => compilerKey({ path, caseSensitive });
  const all = new Map([...files, ...extra]);
  /** Directory key → names of the files and directories directly in it. */
  const listing = new Map<string, { files: Set<string>; directories: Set<string> }>();
  for (const path of all.keys()) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const directory = parts.slice(0, depth).join('/') || '/';
      const entry = listing.get(directory) ?? { files: new Set<string>(), directories: new Set<string>() };
      const name = parts[depth] as string;
      if (depth === parts.length - 1) entry.files.add(name);
      else entry.directories.add(name);
      listing.set(directory, entry);
    }
  }
  return {
    readFile: fileName => { const found = all.get(key(fileName)); return found ?? (isCompilerLibrary(key(fileName)) ? undefined : null); },
    fileExists: fileName => (all.has(key(fileName)) ? true : isCompilerLibrary(key(fileName)) ? undefined : false),
    directoryExists: directoryName => (listing.has(key(directoryName)) ? true : isCompilerLibrary(key(directoryName)) ? undefined : false),
    getAccessibleEntries: directoryName => {
      const entry = listing.get(key(directoryName));
      if (entry != null) return { files: [...entry.files], directories: [...entry.directories] };
      return isCompilerLibrary(key(directoryName)) ? undefined : { files: [], directories: [] };
    },
    realpath: path => path,
  };
}
