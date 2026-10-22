import { describe, expect, it } from 'vitest';
import { createMemoryFsAccess, createFsPolicy, fsTools } from '../../../src/tools/packs/fs/index.js';
import { requestTokens } from '../measure/token-estimator.js';
import { parseAnswer } from './parse-answer.js';
import { createPolicyProvider } from './policy-provider.js';
import type { Policy } from './policy-types.js';
import { readPrompt } from './read-prompt.js';
import { createScriptedSolver } from './scripted-solver.js';

const access = createMemoryFsAccess({ platform: 'posix', files: { '/repo/src/a.ts': 'export const tierCode = 1;\n', '/repo/docs/a.md': 'tierCode\n' } });
const tools = fsTools({ policy: createFsPolicy({ roots: [{ path: '/repo', permissions: ['read'] }] }), access }).filter(({ name }) => name === 'fs_search' || name === 'fs_read');

describe('scripted solver', () => {
  it('plays a policy through the real agent loop: one turn per call batch, then the answer turn', async () => {
    const seen: unknown[] = [];
    const policy: Policy = async ctx => {
      expect(ctx.tools).toEqual(expect.arrayContaining(['fs_search', 'fs_read']));
      const [search] = await ctx.call([{ name: 'fs_search', args: { items: [{ path: '.', pattern: 'tierCode', kind: 'content' }] } }]);
      seen.push(search?.result);
      const reads = await ctx.call([{ name: 'fs_read', args: { items: [{ path: 'src/a.ts' }] } }, { name: 'fs_read', args: { items: [{ path: 'docs/a.md' }] } }]);
      expect(reads.map(({ ok }) => ok)).toEqual([true, true]);
      return { files: ['src/a.ts'] };
    };
    const outcome = await createScriptedSolver({ id: 'p', policy }).solve({ prompt: 'where is `tierCode` used?', scope: ['.'], tools });
    expect(outcome).toMatchObject({ answer: { files: ['src/a.ts'] }, status: 'completed', failures: [], usage: { turns: 3, toolCalls: 3 } });
    expect(outcome.usage.tokens).toBe(outcome.usage.inputTokens + outcome.usage.outputTokens);
    expect(JSON.stringify(seen)).toContain('docs/a.md');
  });

  it('measures the same tokens on every run (deterministic requests)', async () => {
    const policy: Policy = async ctx => { await ctx.call([{ name: 'fs_search', args: { items: [{ path: '.', pattern: 'tierCode', kind: 'content' }] } }]); return { none: true }; };
    const solve = () => createScriptedSolver({ id: 'p', policy }).solve({ prompt: 'p', scope: ['.'], tools });
    const [first, second] = [await solve(), await solve()];
    expect(second.usage.tokens).toBe(first.usage.tokens);
  });

  it('reports a failing policy as a failed run', async () => {
    const outcome = await createScriptedSolver({ id: 'p', policy: async () => { throw new RangeError('broken policy'); } }).solve({ prompt: 'p', scope: ['.'], tools });
    expect(outcome.status).toBe('failed');
    expect(outcome.failures.join(' ')).toMatch(/broken policy/);
  });

  it('answers a compaction request without consulting the policy, with usage from the bench estimator', async () => {
    const provider = createPolicyProvider({ policy: async () => ({ none: true }), prompt: 'p', scope: ['.'] });
    const request = { model: 'm', messages: [{ role: 'user' as const, text: 'summarise' }], tools: [] };
    const events = [];
    for await (const event of provider.stream(request, new AbortController().signal)) events.push(event);
    expect(events).toContainEqual({ type: 'usage', usage: expect.objectContaining({ inputTokens: requestTokens(request) }) });
  });
});

describe('answers and prompts', () => {
  it.each([
    ['{"files":["a"]}', { files: ['a'] }],
    ['Here: {"none": true}', { none: true }],
    ['{"bugs":[{"path":"a","line":"3","cause":"x"}]}', { bugs: [{ path: 'a', line: 3, cause: 'x' }] }],
    ['GET /a', { text: 'GET /a' }],
    ['   ', undefined],
  ])('parses %s', (text, expected) => {
    expect(parseAnswer(text)).toEqual(expected);
  });

  it('reads the question from the prompt alone, and admits when it cannot', () => {
    expect(readPrompt('where is `x.ts`?')).toEqual({ kind: 'find-file', name: 'x.ts' });
    expect(readPrompt('what tests cover `x.ts`?')).toEqual({ kind: 'tests-for', module: 'x.ts' });
    expect(readPrompt('who reads `API_URL`?')).toEqual({ kind: 'env-var', name: 'API_URL' });
    expect(readPrompt('trace `GET /api/a`')).toEqual({ kind: 'route-trace', endpoint: 'GET /api/a' });
    expect(readPrompt('make me a sandwich')).toBeUndefined();
  });
});
