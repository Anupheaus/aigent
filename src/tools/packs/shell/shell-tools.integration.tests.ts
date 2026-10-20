import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AigentEvent } from '../../../core/aigent-events.js';
import { createAigent } from '../../../core/create-aigent.js';
import type { AigentOptions } from '../../../core/aigent-types.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { tempRoot } from '../../../security/temp-dir.test-support.js';
import { createInMemoryStore } from '../../../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../../../testing/fake-provider.js';
import type { FakeTurn } from '../../../testing/fake-provider.js';
import { createShellPolicy, shellTools } from './index.js';

let root = '';
let cleanup: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  ({ root, cleanup } = await tempRoot());
  await writeFile(join(root, 'touch.cjs'), 'require("node:fs").writeFileSync(process.argv[2], "made")');
});
afterAll(() => cleanup());

function setup(params: { turns: FakeTurn[]; requiresApproval?: boolean; options?: Partial<AigentOptions> }) {
  const { turns, requiresApproval = false, options = {} } = params;
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false, ...options });
  const policy = createShellPolicy({ commands: [{ name: 'node', resolvedPath: process.execPath, requiresApproval }], cwdPolicy: createFsPolicy({ roots: [{ path: root, permissions: ['read'] }] }) });
  const agent = ai.agent({ name: 'runner', model: 'fake:m', todo: false, tools: shellTools({ policy }) });
  return { ai, agent, provider };
}

const run = (id: string, items: unknown[]) => toolTurn([{ id, name: 'shell_run', args: { items } }]);
const resultOf = (provider: ReturnType<typeof createFakeProvider>, callId: string) => JSON.parse(provider.requests.flatMap(({ messages }) => messages).find(({ toolCallId }) => toolCallId === callId)?.text ?? '{}');

describe('shell_run in the agent loop', () => {
  it('asks for approval, and runs once it is given', async () => {
    const file = join(root, 'approved.txt');
    const { ai, agent } = setup({ turns: [run('s1', [{ command: 'node', args: [join(root, 'touch.cjs'), file] }]), textTurn('done')], requiresApproval: true });
    const handle = agent.task({ task: 'touch it' });
    const events: AigentEvent[] = [];
    for await (const event of handle) {
      events.push(event);
      if (event.type === 'approval-request') void agent.approve(event.requestId, { decision: 'allow_once' });
    }
    await handle;
    expect(events.some(({ type }) => type === 'approval-request')).toBe(true);
    expect(existsSync(file)).toBe(true);
    await ai.close();
  });

  it('refuses in an unattended run unless an allow rule grants it', async () => {
    const file = join(root, 'unattended.txt');
    const denied = setup({ turns: [run('s1', [{ command: 'node', args: [join(root, 'touch.cjs'), file] }]), textTurn('done')], requiresApproval: true });
    await denied.agent.task({ task: 'touch it', unattended: true });
    expect(resultOf(denied.provider, 's1')).toMatchObject({ ok: false, error: { code: 'approval_denied' } });
    expect(existsSync(file)).toBe(false);
    await denied.ai.close();
    const granted = setup({ turns: [run('s1', [{ command: 'node', args: [join(root, 'touch.cjs'), file] }]), textTurn('done')], requiresApproval: true, options: { approvals: { allow: [{ tool: 'shell_run' }] } } });
    await granted.agent.task({ task: 'touch it', unattended: true });
    expect(existsSync(file)).toBe(true);
    await granted.ai.close();
  });

  it('cleans terminal noise for the model with the original under a handle, and leaves raw output alone', async () => {
    const noisy = 'process.stdout.write("\\u001b[31mred\\u001b[0m\\nstep 1%\\rstep 100%\\n")';
    const { ai, agent, provider } = setup({ turns: [run('s1', [{ command: 'node', args: ['-e', noisy] }, { command: 'node', args: ['-e', noisy], raw: true }]), textTurn('done')] });
    await agent.task({ task: 'run it' });
    const seen = resultOf(provider, 's1');
    expect(seen.result.result[0].result.stdout).toBe('red\nstep 100%\n');
    expect(seen.result.result[1].result.stdout).toContain('\u001b[31m');
    expect(seen.result.shaping[0]).toMatchObject({ shaper: 'strip-noise', handle: expect.any(String) });
    await ai.close();
  });
});
