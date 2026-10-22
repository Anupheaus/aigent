import { describe, expect, it } from 'vitest';
import { isAigentError } from '../../../core/aigent-error.js';
import { executeToolCall } from '../../execute-tool-call.js';
import type { ExecutedToolCall } from '../../execute-tool-call.js';
import { createToolRegistry } from '../../tool-registry.js';
import type { RequiresApproval } from '../../../approvals/approval-types.js';
import type { Tool, ToolActivityView, ToolContext } from '../../tool-types.js';
import { createDbPolicy, createMemoryDbAccess, dbTools } from './index.js';
import type { DbAccess, DbPolicyOptions, DbToolsOptions } from './index.js';
import { countingAccess, fixtureAccess } from './db-tools.test-support.js';
import type { CountingAccess } from './db-tools.test-support.js';

const CONTEXT: ToolContext = { agentName: 'a', instanceId: 'i', runId: 'r', callId: 'c1', signal: new AbortController().signal };
const POLICY_OPTIONS: DbPolicyOptions = {
  collections: {
    people: { permissions: ['read'], denyFields: ['password', 'profile.ssn'], maxLimit: 50 },
    audit: { permissions: ['read'], requiresApproval: true },
  },
};

function toolWith(params: { access?: DbAccess; options?: Partial<DbToolsOptions>; policy?: DbPolicyOptions } = {}): { tool: Tool; access: DbAccess } {
  const { access = fixtureAccess(), options = {}, policy = POLICY_OPTIONS } = params;
  const [tool] = dbTools({ policy: createDbPolicy(policy), access, ...options });
  return { tool: tool as Tool, access };
}

async function call(params: { tool: Tool; items: unknown[]; context?: Partial<ToolContext> }): Promise<ExecutedToolCall> {
  const { tool, items, context = {} } = params;
  return executeToolCall({ registry: createToolRegistry([tool]), call: { id: 'c1', name: tool.name, args: { items } }, context: { ...CONTEXT, ...context }, now: () => 0 });
}

interface Entry {
  ok: boolean;
  result?: Record<string, unknown> & { docs: Record<string, unknown>[] };
  error?: { category: string; code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
}

function entries(executed: ExecutedToolCall): Entry[] {
  if (!executed.envelope.ok) throw new Error(executed.envelope.error.message);
  return executed.envelope.result as Entry[];
}

describe('db_query: contract', () => {
  it('is a read-only, cached-for-30-seconds, lossy-ok structured-data batch tool', () => {
    expect(toolWith().tool).toMatchObject({ name: 'db_query', hasSideEffects: false, deterministic: false, cache: true, cacheTtlMs: 30_000, contentKind: 'structured-data', fidelity: 'lossy-ok', maxResultTokens: 8_000 });
  });

  it('takes a configurable cache TTL, or none', () => {
    expect(toolWith({ options: { cacheTtlMs: 5_000 } }).tool).toMatchObject({ cache: true, cacheTtlMs: 5_000 });
    expect(toolWith({ options: { cacheTtlMs: false } }).tool).toMatchObject({ cache: false });
  });

  it('asks for approval only for queries on collections that require it', () => {
    const { requiresApproval } = toolWith().tool;
    const { when } = requiresApproval as Exclude<RequiresApproval, boolean | ((...args: never[]) => boolean)>;
    expect(when?.({ items: [{ collection: 'people' }] }, CONTEXT)).toBe(false);
    expect(when?.({ items: [{ collection: 'people' }, { collection: 'audit' }] }, CONTEXT)).toBe(true);
    expect(toolWith({ policy: { collections: { people: { permissions: ['read'] } } } }).tool.requiresApproval).toBeUndefined();
  });

  it('needs a policy and an access', () => {
    for (const options of [{}, { policy: createDbPolicy(POLICY_OPTIONS) }]) {
      try {
        dbTools(options as DbToolsOptions);
        throw new Error('expected a definition error');
      } catch (error) {
        expect(isAigentError(error) && error.code === 'invalid_definition').toBe(true);
      }
    }
  });
});

describe('db_query: queries', () => {
  it('runs a filter given as JSON text, with tagged dates, a count, and denied fields projected away', async () => {
    const access = fixtureAccess();
    const { tool } = toolWith({ access });
    const [entry] = entries(await call({ tool, items: [{ collection: 'people', filter: '{"age":{"$gte":30}}', sort: [{ field: 'age', direction: 'asc' }], count: true }] }));
    expect(entry).toEqual({
      index: 0, ok: true,
      result: {
        collection: 'people', count: 2, returned: 2, truncated: false,
        docs: [
          { _id: 1, name: 'Ann', age: 34, profile: { city: 'Leeds' }, joined: { $date: '2020-02-01T00:00:00.000Z' } },
          { _id: 3, name: 'Cy', age: 51, profile: { city: 'Hull' }, joined: { $date: '2019-04-01T00:00:00.000Z' } },
        ],
      },
    });
    expect(access.calls.map(({ method, params }) => [method, params])).toEqual([
      ['find', { collection: 'people', filter: { age: { $gte: 30 } }, projection: { password: 0, 'profile.ssn': 0 }, sort: [{ field: 'age', direction: 'asc' }], limit: 20, maxTimeMs: 5_000 }],
      ['count', { collection: 'people', filter: { age: { $gte: 30 } }, maxTimeMs: 5_000 }],
    ]);
  });

  it('refuses before reaching the database, with the policy code and path', async () => {
    const access = fixtureAccess();
    const { tool } = toolWith({ access });
    const results = entries(await call({ tool, items: [
      { collection: 'secrets' },
      { collection: 'people', filter: '{"$where":"sleep(1)"}' },
      { collection: 'people', filter: '{"age": ' },
      { collection: 'people', projection: ['password'] },
      { collection: 'people', limit: 51 },
    ] }));
    expect(results.map(({ error }) => [error?.category, error?.code, error?.details?.path])).toEqual([
      ['denied', 'collection_denied', 'collection'],
      ['denied', 'operator_forbidden', 'filter.$where'],
      ['validation', 'invalid_json', undefined],
      ['denied', 'field_denied', 'projection[0]'],
      ['denied', 'limit_exceeded', 'limit'],
    ]);
    expect(access.calls).toEqual([]);
  });

  it('removes denied fields client-side too, whatever the access returns', async () => {
    const leaky: DbAccess = { find: async () => ({ docs: [{ name: 'Ann', password: 'p1', profile: { ssn: '1', city: 'x' } }], truncated: false }), count: async () => 1 };
    const [entry] = entries(await call({ tool: toolWith({ access: leaky }).tool, items: [{ collection: 'people' }] }));
    expect(entry?.result?.docs).toEqual([{ name: 'Ann', profile: { city: 'x' } }]);
  });

  it('marks more matches than the limit as truncated, with a note on paging', async () => {
    const [entry] = entries(await call({ tool: toolWith().tool, items: [{ collection: 'people', limit: 2 }] }));
    expect(entry?.result).toMatchObject({ returned: 2, truncated: true, note: expect.stringMatching(/skip/) });
  });

  it('cuts long text values with a visible marker, never silently', async () => {
    const long = 'x'.repeat(5_000);
    const access = createMemoryDbAccess({ collections: { people: [{ _id: 1, bio: long }] } });
    const [entry] = entries(await call({ tool: toolWith({ access }).tool, items: [{ collection: 'people' }] }));
    const bio = entry?.result?.docs[0]?.bio as string;
    expect(bio.length).toBeLessThan(2_100);
    expect(bio).toMatch(/\[truncated: 3000 more characters\]$/);
    expect(entry?.result).toMatchObject({ truncated: true, note: expect.stringMatching(/cut/) });
  });

  it('drops trailing documents to fit the result budget, saying how many', async () => {
    const docs = Array.from({ length: 50 }, (_, index) => ({ _id: index, text: 'y'.repeat(1_500) }));
    const access = createMemoryDbAccess({ collections: { people: docs } });
    const [entry] = entries(await call({ tool: toolWith({ access, options: { maxResultTokens: 4_000 } }).tool, items: [{ collection: 'people', limit: 50 }] }));
    const returned = entry?.result?.returned as number;
    expect(returned).toBeGreaterThan(3);
    expect(returned).toBeLessThan(15);
    expect(entry?.result?.docs).toHaveLength(returned);
    expect(entry?.result).toMatchObject({ truncated: true, note: expect.stringContaining(`${50 - returned} of 50`) });
  });

  it('turns database errors into retryable failures without credentials, and stops on abort', async () => {
    const secret = ['s3cr', 'et!'].join('');
    const failing: DbAccess = { find: async () => { throw new Error(`auth failed for mongodb://app:${secret}@db.internal:27017`); }, count: async () => 0 };
    const [failed] = entries(await call({ tool: toolWith({ access: failing }).tool, items: [{ collection: 'people' }] }));
    expect(failed?.error).toMatchObject({ code: 'db_error', retryable: true });
    expect(failed?.error?.message).not.toContain(secret);
    const controller = new AbortController();
    const slow: CountingAccess = countingAccess({ find: () => new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason))), count: async () => 0 });
    const pending = call({ tool: toolWith({ access: slow }).tool, items: [{ collection: 'people' }], context: { signal: controller.signal } });
    controller.abort();
    const executed = await pending;
    expect(executed.envelope.ok ? (executed.envelope.result as Entry[])[0]?.error?.category : executed.envelope.error.category).toBe('aborted');
  });

  it('describes its activity per collection', async () => {
    const { tool } = toolWith();
    const one = await tool.describeActivity({ items: [{ collection: 'people' }] }, Promise.resolve({ success: true, reason: 'ok' })) as ToolActivityView;
    const many = await tool.describeActivity({ items: [{ collection: 'people' }, { collection: 'audit' }] }, Promise.resolve({ success: false, reason: '1 of 2 items failed: denied' })) as ToolActivityView;
    expect(one).toEqual({ title: 'Querying people' });
    expect(many).toEqual({ title: 'Querying 2 collections', detail: '1 of 2 items failed: denied' });
  });
});
