import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { tempRoot } from '../../../security/temp-dir.test-support.js';
import { executeToolCall } from '../../execute-tool-call.js';
import type { ExecutedToolCall } from '../../execute-tool-call.js';
import { createToolRegistry } from '../../tool-registry.js';
import type { Tool, ToolContext } from '../../tool-types.js';
import { createShellPolicy, shellTools } from './index.js';
import type { ShellToolsOptions } from './index.js';

let root = '';
let cleanup: () => Promise<void> = async () => undefined;
const CONTEXT: ToolContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c1', signal: new AbortController().signal };

beforeAll(async () => {
  ({ root, cleanup } = await tempRoot());
  await writeFile(join(root, 'touch.cjs'), 'require("node:fs").writeFileSync(process.argv[2], "made"); process.stdout.write("done")');
  await writeFile(join(root, 'read.cjs'), 'process.stdout.write(require("node:fs").readFileSync(process.argv[2], "utf8"))');
});
afterAll(() => cleanup());

function toolWith(options: Partial<ShellToolsOptions> & { timeoutMs?: number; maxOutputBytes?: number; requiresApproval?: boolean } = {}): Tool {
  const { timeoutMs, maxOutputBytes, requiresApproval, ...rest } = options;
  const policy = createShellPolicy({
    commands: [{ name: 'node', resolvedPath: process.execPath, ...(requiresApproval == null ? {} : { requiresApproval }) }],
    cwdPolicy: createFsPolicy({ roots: [{ path: root, permissions: ['read'] }] }),
    ...(timeoutMs == null ? {} : { timeoutMs }), ...(maxOutputBytes == null ? {} : { maxOutputBytes }),
  });
  const [tool] = shellTools({ policy, ...rest });
  return tool as Tool;
}

const node = (args: string[], extra: Record<string, unknown> = {}) => ({ command: 'node', args, ...extra });

async function call(params: { tool: Tool; items: unknown[]; context?: Partial<ToolContext> }): Promise<ExecutedToolCall> {
  const { tool, items, context = {} } = params;
  return executeToolCall({ registry: createToolRegistry([tool]), call: { id: 'c1', name: tool.name, args: { items } }, context: { ...CONTEXT, ...context }, now: () => 0 });
}

function entries(executed: ExecutedToolCall): { ok: boolean; result?: Record<string, unknown>; error?: Record<string, unknown> }[] {
  if (!executed.envelope.ok) throw new Error(executed.envelope.error.message);
  return executed.envelope.result as never;
}

describe('shell_run', () => {
  it('declares its contract: side effects, high risk, resume ask, command output, no cache', () => {
    expect(toolWith()).toMatchObject({ name: 'shell_run', hasSideEffects: true, deterministic: false, cache: false, risk: 'high', resume: 'ask', contentKind: 'command-output', fidelity: 'lossy-ok' });
  });

  it('returns stdout, stderr and exit codes; a non-zero exit is a result, not a failure', async () => {
    const [ok, failed] = entries(await call({ tool: toolWith(), items: [node(['-e', 'process.stdout.write("hi"); process.stderr.write("warn")']), node(['-e', 'process.exit(7)'])] }));
    expect(ok).toMatchObject({ ok: true, result: { command: 'node', exitCode: 0, stdout: 'hi', stderr: 'warn', timedOut: false } });
    expect(failed).toMatchObject({ ok: true, result: { exitCode: 7 } });
  });

  it('refuses what the policy refuses, with its code', async () => {
    const results = entries(await call({ tool: toolWith(), items: [{ command: 'git', args: [] }, node([], { cwd: join(root, '..') }), { command: './node', args: [] }] }));
    expect(results.map(({ error }) => error?.code)).toEqual(['command_not_allowed', 'cwd_denied', 'command_not_allowed']);
    expect(results[0]?.error).toMatchObject({ category: 'denied' });
  });

  it('fails a run that times out, and marks output cut at the cap', async () => {
    const [slow] = entries(await call({ tool: toolWith({ timeoutMs: 300 }), items: [node(['-e', 'setInterval(() => {}, 1000)'])] }));
    expect(slow?.error).toMatchObject({ code: 'timeout' });
    const [flood] = entries(await call({ tool: toolWith({ maxOutputBytes: 1_000 }), items: [node(['-e', 'setInterval(() => process.stdout.write("x".repeat(500)), 0)'])] }));
    expect(flood).toMatchObject({ ok: true, result: { truncated: { stdout: true } } });
    expect(String(flood?.result?.stdout)).toContain('[output truncated at 1000 bytes');
  });

  it('passes stdin, and runs items in order by default', async () => {
    const file = join(root, 'ordered.txt');
    const results = entries(await call({ tool: toolWith(), items: [node([join(root, 'touch.cjs'), file]), node([join(root, 'read.cjs'), file]), node(['-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'piped' })] }));
    expect(results.map(({ result }) => result?.stdout)).toEqual(['done', 'made', 'piped']);
  });

  it('plans without running anything in a dry run: the resolved program, argv, cwd and env names', async () => {
    const file = join(root, 'dry.txt');
    const executed = await call({ tool: toolWith(), items: [node([join(root, 'touch.cjs'), file])], context: { dryRun: true } });
    expect(existsSync(file)).toBe(false);
    expect(executed.plannedEffects).toEqual([expect.objectContaining({ kind: 'process.run', reversible: false, summary: expect.stringContaining('node') })]);
    const simulated = JSON.stringify(executed.envelope.ok ? executed.envelope.result : executed.envelope.error);
    expect(simulated).toContain(JSON.stringify(root).slice(1, -1));
    expect(simulated).toContain('"envNames":[');
    expect(simulated).toContain('"PATH"');
  });

  it('asks for approval as the policy says, or always', () => {
    const when = (tool: Tool) => (tool.requiresApproval as { when(args: unknown, context: unknown): boolean }).when({ items: [node(['-v'])] }, CONTEXT);
    expect(when(toolWith())).toBe(false);
    expect(when(toolWith({ requiresApproval: true }))).toBe(true);
    expect(when(toolWith({ approvals: 'always' }))).toBe(true);
  });

  it('titles activity with the command and its first arguments', async () => {
    const tool = toolWith();
    const view = await tool.describeActivity({ items: [node(['-e', 'x'.repeat(100)])] }, Promise.resolve({ success: true, reason: '' })) as { title: string };
    expect(view.title.startsWith('Running node -e x')).toBe(true);
    expect(view.title.length).toBeLessThanOrEqual(70);
  });
});
