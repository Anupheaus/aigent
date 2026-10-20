import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AigentEvent } from '../../../core/aigent-events.js';
import { createAigent } from '../../../core/create-aigent.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { createShellPolicy } from '../../../security/shell-policy.js';
import { createInMemoryStore } from '../../../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../../../testing/fake-provider.js';
import type { FakeTurn } from '../../../testing/fake-provider.js';
import { findGit, git, IDENTITY, scriptedRepo } from './git-repo.test-support.js';
import { gitTools } from './index.js';

const gitPath = findGit();
let setup: Awaited<ReturnType<typeof scriptedRepo>>;

function agentWith(turns: FakeTurn[]) {
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false });
  const policy = createShellPolicy({ commands: [{ name: 'git', resolvedPath: gitPath as string }], cwdPolicy: createFsPolicy({ roots: [{ path: setup.workspace, permissions: ['read', 'write'] }] }) });
  const agent = ai.agent({ name: 'gitter', model: 'fake:m', todo: false, tools: gitTools({ policy, identity: IDENTITY, enableWrites: { commit: true } }) });
  return { ai, agent };
}

describe.skipIf(gitPath == null)(`the git pack in the agent loop${gitPath == null ? ' (skipped: git is not installed)' : ''}`, () => {
  beforeAll(async () => { setup = await scriptedRepo(); });
  afterAll(() => setup.cleanup());

  it('serves a repeated log pinned to a full hash from the cache, never an unpinned one', async () => {
    const log = (id: string, ref: string) => toolTurn([{ id, name: 'git_log', args: { items: [{ repo: 'repo', ref }] } }]);
    const pinned = setup.commits[0] as string;
    const { ai, agent } = agentWith([log('l1', pinned), log('l2', pinned), log('l3', 'main'), log('l4', 'main'), textTurn('done')]);
    const result = await agent.task({ task: 'read the log' });
    const trace = await ai.trace(result.runId);
    expect(trace?.steps.map(({ cacheHit }) => cacheHit)).toEqual([false, true, false, false]);
    await ai.close();
  });

  it('asks before committing, and commits once approved', async () => {
    const before = git({ cwd: setup.repo, args: ['rev-parse', 'HEAD'] }).trim();
    const { ai, agent } = agentWith([toolTurn([{ id: 'c1', name: 'git_commit', args: { repo: 'repo', message: 'approved change', paths: ['b.txt'], allowEmpty: null } }]), textTurn('done')]);
    const handle = agent.task({ task: 'commit b' });
    const events: AigentEvent[] = [];
    for await (const event of handle) {
      events.push(event);
      if (event.type === 'approval-request') void agent.approve(event.requestId, { decision: 'allow_once' });
    }
    await handle;
    expect(events.filter(({ type }) => type === 'approval-request')).toHaveLength(1);
    expect(git({ cwd: setup.repo, args: ['log', '-1', '--format=%s'] }).trim()).toBe('approved change');
    expect(git({ cwd: setup.repo, args: ['rev-parse', 'HEAD~1'] }).trim()).toBe(before);
    await ai.close();
  });
});
