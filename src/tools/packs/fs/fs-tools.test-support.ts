import { createMemoryFsAccess } from '../../../security/fs-access-memory.js';
import type { MemoryFsEntry } from '../../../security/fs-access-memory.js';
import type { FsAccess } from '../../../security/fs-access.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import type { FsPolicyOptions } from '../../../security/fs-policy-types.js';
import { executeToolCall } from '../../execute-tool-call.js';
import type { ExecutedToolCall } from '../../execute-tool-call.js';
import { createToolRegistry } from '../../tool-registry.js';
import type { Tool, ToolContext } from '../../tool-types.js';
import type { FsDeps } from './fs-shared.js';

export const CONTEXT: ToolContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c1', signal: new AbortController().signal, idempotencyKey: 'r:c1' };

/** A posix memory disk with a workspace root (read, write, delete), a read-only docs root and a backup directory. */
export function memoryDeps(params: { files?: Record<string, MemoryFsEntry>; policy?: Partial<FsPolicyOptions>; approvals?: FsDeps['approvals']; backupDir?: string | null } = {}): FsDeps & { access: FsAccess } {
  const { files = {}, policy = {}, approvals = 'none', backupDir = '/backups' } = params;
  const access = createMemoryFsAccess({ platform: 'posix', files: { '/ws': { dir: true }, '/docs': { dir: true }, '/backups': { dir: true }, ...files } });
  let now = 1_000;
  return {
    access, approvals, clock: { now: () => (now += 1) },
    policy: createFsPolicy({ roots: [{ path: '/ws', permissions: ['read', 'write', 'delete'], label: 'workspace' }, { path: '/docs', permissions: ['read'] }], ...policy }),
    ...(backupDir == null ? {} : { backupDir }),
  };
}

/** Runs one call of `tool` the way a run does (validation, dry runs, undo capture), with `items` as its arguments. */
export function call(params: { tool: Tool; items: unknown[]; context?: Partial<ToolContext> }): Promise<ExecutedToolCall> {
  const { tool, items, context = {} } = params;
  return executeToolCall({ registry: createToolRegistry([tool]), call: { id: 'c1', name: tool.name, args: { items } }, context: { ...CONTEXT, ...context }, now: () => 0 });
}

/** The per-item entries of a successful batch call. */
export function entriesOf(executed: ExecutedToolCall): { index: number; ok: boolean; result?: Record<string, unknown>; error?: Record<string, unknown> }[] {
  if (!executed.envelope.ok) throw new Error(`call failed: ${executed.envelope.error.message}`);
  return executed.envelope.result as never;
}

export async function textAt(access: FsAccess, path: string): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await access.readFile(path));
}
