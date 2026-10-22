import { createAigentError } from '../core/aigent-error.js';
import type { FsAccess } from '../security/fs-access.js';
import type { FsPolicy } from '../security/fs-policy-types.js';
import { matchGlob } from '../security/glob.js';
import type { KnowledgeSource } from './knowledge-types.js';

/** Directories never walked into when scanning for sources. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'coverage']);

/** A path source's text and modification time, or why it could not be read. */
export type ReadSourceResult =
  | { ok: true; text: string; mtimeMs: number }
  | { ok: false; code: string; message: string };

/** The file's mtime through the policy (a `read` check first), or why not. */
export async function statSource(params: { fs: { access: FsAccess; policy: FsPolicy }; path: string }): Promise<{ ok: true; path: string; mtimeMs: number; size: number } | { ok: false; code: string; message: string }> {
  const { fs: { access, policy }, path } = params;
  const decision = await policy.check({ path, permission: 'read', access });
  if (!decision.allowed) return { ok: false, code: decision.code, message: decision.message };
  try {
    const { type, mtimeMs, size } = await access.stat(decision.canonicalPath);
    if (type !== 'file') return { ok: false, code: 'not_a_file', message: `'${path}' is not a file` };
    if (size > policy.limits.maxReadBytes) return { ok: false, code: 'too_large', message: `'${path}' is ${size} bytes; the policy reads at most ${policy.limits.maxReadBytes}` };
    return { ok: true, path: decision.canonicalPath, mtimeMs, size };
  } catch (error) {
    return { ok: false, code: 'unreadable', message: `'${path}' could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Reads a path source through the policy (`read`, size limit) as UTF-8 text. */
export async function readSource(params: { fs: { access: FsAccess; policy: FsPolicy }; path: string }): Promise<ReadSourceResult> {
  const { fs } = params;
  const checked = await statSource(params);
  if (!checked.ok) return checked;
  try {
    return { ok: true, text: new TextDecoder().decode(await fs.access.readFile(checked.path)), mtimeMs: checked.mtimeMs };
  } catch (error) {
    return { ok: false, code: 'unreadable', message: `'${params.path}' could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** `scanSources(options)`. */
export interface ScanSourcesOptions {
  access: FsAccess;
  policy: FsPolicy;
  /** The directory to walk (inside the policy's roots). */
  root: string;
  /** Globs relative to `root` (`/` separated); default every file. */
  include?: string[];
}

/**
 * Path sources for every readable file under `root`: directories and files the policy refuses (deny globs, outside the
 * roots) are skipped, as are dependency and VCS directories; ids are the `/`-separated paths relative to `root`. More
 * matching files than the policy's `maxFiles` is an error, never a silently shortened list.
 */
export async function scanSources(options: ScanSourcesOptions): Promise<KnowledgeSource[]> {
  const { access, policy, root, include } = options;
  const decision = await policy.check({ path: root, permission: 'read', access });
  if (!decision.allowed) throw createAigentError({ code: 'invalid_input', message: `scanSources: '${root}' is not readable: ${decision.message}`, details: { root, code: decision.code } });
  const separator = access.platform === 'win32' ? '\\' : '/';
  const { maxFiles } = policy.limits;
  const sources: KnowledgeSource[] = [];
  const walk = async (directory: string, relative: string): Promise<void> => {
    for (const entry of await access.readdir(directory)) {
      const path = `${directory}${directory.endsWith(separator) ? '' : separator}${entry.name}`;
      const id = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (policy.isDenied({ path, root: decision.root, permission: 'read', access })) continue;
      if (entry.type === 'directory') {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path, id);
        continue;
      }
      if (entry.type !== 'file' || (include != null && !include.some(pattern => matchGlob(pattern, id)))) continue;
      // A partial list would look complete, and `index({ prune: true })` would drop every file left off it.
      if (sources.length >= maxFiles) throw createAigentError({ code: 'invalid_input', message: `scanSources: '${root}' holds more than ${maxFiles} files (the policy's maxFiles); narrow it with include, or raise maxFiles`, details: { root, maxFiles } });
      sources.push({ id, uri: `file://${path.replaceAll('\\', '/')}`, path });
    }
  };
  await walk(decision.canonicalPath, '');
  return sources;
}
