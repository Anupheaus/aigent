import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { UserFeedbackRecord } from '../feedback/feedback-records.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { CompareAndSetParams, Store } from '../store/store-types.js';
import type { Redact } from '../telemetry/redact.js';
import type { RunRecord } from '../telemetry/run-record.js';
import { createFakeProvider, textTurn } from '../testing/fake-provider.js';
import { createAigent } from './create-aigent.js';
import type { AigentOptions } from './create-aigent.js';
import type { Clock, IdGenerator } from './runtime-services.js';

const CONCURRENT_RATINGS = 20;
const SECRET = 'my-password';

function tickingClock(): Clock {
  let current = 1_000;
  return { now: () => { current += 1; return current; } };
}

function sequentialIds(prefix: string): IdGenerator {
  let counter = 0;
  return { next: kind => `${kind}_${prefix}${++counter}` };
}

function setup(params: { store?: Store; options?: Partial<AigentOptions>; turns?: number } = {}) {
  const { store = createInMemoryStore(), options = {}, turns = 3 } = params;
  const provider = createFakeProvider({ turns: Array.from({ length: turns }, () => textTurn('src/theme.ts')) });
  const ai = createAigent({ providers: [provider], clock: tickingClock(), ids: sequentialIds('a'), store, enableFeedback: false, ...options });
  const agent = ai.agent({ name: 'helper', model: 'fake:m' });
  return { ai, agent, store };
}

async function userFeedback(store: Store, responseId: string): Promise<UserFeedbackRecord | undefined> {
  return (await store.get<UserFeedbackRecord>('feedback', responseId))?.value;
}

describe('ai.feedback', () => {
  it('stores the rating against the response and marks the run record with the verdict', async () => {
    const { ai, agent, store } = setup();
    const result = await agent.task({ task: 'Find the theme file', scope: { tenant: 't1' } });
    await ai.feedback({ responseId: result.responseId, rating: 'incorrect', comment: 'Wrong file', expectedAnswer: 'src/providers/ThemeProvider.tsx' });
    expect(await userFeedback(store, result.responseId)).toEqual({
      schemaVersion: 1, runId: result.runId, agentName: 'helper', instanceId: agent.instanceId, mode: 'task', agentVersion: agent.agentVersion, scope: { tenant: 't1' },
      recordedAt: expect.any(Number), kind: 'user', responseId: result.responseId, rating: 'incorrect', comment: 'Wrong file', expectedAnswer: 'src/providers/ThemeProvider.tsx',
      history: [{ at: expect.any(Number), rating: 'incorrect', comment: 'Wrong file' }],
    });
    expect((await store.get<RunRecord>('runs', result.runId))?.value.userVerdict).toBe('incorrect');
  });

  it('stores a responses index entry for every stored run', async () => {
    const { agent, store } = setup();
    const result = await agent.task({ task: 'x' });
    expect((await store.get('responses', result.responseId))?.value).toMatchObject({ schemaVersion: 1, responseId: result.responseId, runId: result.runId, agentName: 'helper', instanceId: agent.instanceId, agentVersion: agent.agentVersion });
  });

  it('amends: a later rating replaces the current one and keeps the history', async () => {
    const { ai, agent, store } = setup();
    const result = await agent.task({ task: 'x' });
    await ai.feedback({ responseId: result.responseId, rating: 'partial', comment: 'Half right' });
    await ai.feedback({ responseId: result.responseId, rating: 'correct' });
    const stored = await userFeedback(store, result.responseId);
    expect(stored).toMatchObject({ rating: 'correct', history: [{ rating: 'partial', comment: 'Half right' }, { rating: 'correct' }] });
    expect(stored).not.toHaveProperty('comment');
    expect((await store.get<RunRecord>('runs', result.runId))?.value.userVerdict).toBe('correct');
  });

  it('offers result.feedback as sugar for the same thing', async () => {
    const { agent, store } = setup();
    const result = await agent.task({ task: 'x' });
    await result.feedback({ rating: 'correct' });
    expect(await userFeedback(store, result.responseId)).toMatchObject({ rating: 'correct' });
    expect(Object.keys(result)).not.toContain('feedback');
  });

  it('works from a second createAigent on the same store, after the first is closed', async () => {
    const store = createInMemoryStore();
    const first = setup({ store });
    const result = await first.agent.task({ task: 'x' });
    await first.ai.close();
    const second = createAigent({ providers: [createFakeProvider({ turns: [] })], store });
    await second.feedback({ responseId: result.responseId, rating: 'correct' });
    expect((await store.get<RunRecord>('runs', result.runId))?.value.userVerdict).toBe('correct');
  });

  it('loses no history under concurrent ratings of one response', async () => {
    const { ai, agent, store } = setup();
    const result = await agent.task({ task: 'x' });
    const second = createAigent({ providers: [createFakeProvider({ turns: [] })], store });
    const ratings = Array.from({ length: CONCURRENT_RATINGS }, (_, ratingNumber) => (ratingNumber % 2 === 0 ? ai : second).feedback({ responseId: result.responseId, rating: 'partial', comment: `rating ${ratingNumber}` }));
    await Promise.all(ratings);
    const history = (await userFeedback(store, result.responseId))?.history ?? [];
    expect(history.map(({ comment }) => comment).sort()).toEqual(Array.from({ length: CONCURRENT_RATINGS }, (_, ratingNumber) => `rating ${ratingNumber}`).sort());
  });

  it('rejects an unknown responseId with invalid_input naming it', async () => {
    const { ai } = setup();
    await expect(ai.feedback({ responseId: 'resp_nope', rating: 'correct' })).rejects.toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining("'resp_nope'") }));
  });

  it('rejects feedback on a disableTelemetry run clearly, since nothing of it was stored', async () => {
    const { ai, agent } = setup();
    const result = await agent.task({ task: 'x', disableTelemetry: true });
    await expect(ai.feedback({ responseId: result.responseId, rating: 'correct' })).rejects.toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringMatching(/'resp_a\d+'.*disableTelemetry/) }));
  });

  it('rejects an invalid payload precisely and without a store says why', async () => {
    const { ai } = setup();
    await expect(ai.feedback({ responseId: 'resp_1', rating: 'great' as 'correct' })).rejects.toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('rating') }));
    const storeless = createAigent({ providers: [createFakeProvider({ turns: [] })] });
    await expect(storeless.feedback({ responseId: 'resp_1', rating: 'correct' })).rejects.toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('no store') }));
  });

  it('passes the feedback and the verdict update through redact', async () => {
    const memory = createInMemoryStore();
    const written: CompareAndSetParams<unknown>[] = [];
    const store: Store = { ...memory, compareAndSet: params => { written.push(structuredClone(params)); return memory.compareAndSet(params); } };
    const redacted = new Set<string>();
    const { ai, agent } = setup({ store, options: { redact: ({ collection, key, value }) => { redacted.add(collection); return { collection, key, value: JSON.parse(JSON.stringify(value).replaceAll(SECRET, '[x]')) }; } } });
    const result = await agent.task({ task: 'x' });
    await ai.feedback({ responseId: result.responseId, rating: 'incorrect', comment: `I typed ${SECRET} by mistake`, expectedAnswer: SECRET });
    expect([...redacted].sort()).toEqual(['feedback', 'responses', 'runs', 'traces']);
    expect(JSON.stringify(written)).not.toContain(SECRET);
    expect((await memory.get<RunRecord>('runs', result.runId))?.value.userVerdict).toBe('incorrect');
  });

  it('applies a non-idempotent (hashing) redact once: re-written records are not hashed again', async () => {
    const digest = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
    const HASHED_KEYS = new Set(['task', 'comment', 'expectedAnswer']);
    const hashFields = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(hashFields);
      if (typeof value !== 'object' || value === null) return value;
      return Object.fromEntries(Object.entries(value).map(([field, inner]) => [field, HASHED_KEYS.has(field) && typeof inner === 'string' ? digest(inner) : hashFields(inner)]));
    };
    const redact: Redact = ({ collection, key, value }) => ({ collection, key, value: hashFields(value) });
    const { ai, agent, store } = setup({ options: { redact } });
    const result = await agent.task({ task: 'secret task' });
    await ai.feedback({ responseId: result.responseId, rating: 'partial', comment: 'first' });
    await ai.feedback({ responseId: result.responseId, rating: 'incorrect', comment: 'second', expectedAnswer: 'answer' });
    expect((await store.get<RunRecord>('runs', result.runId))?.value).toMatchObject({ task: digest('secret task'), userVerdict: 'incorrect' });
    expect(await userFeedback(store, result.responseId)).toMatchObject({
      rating: 'incorrect', comment: digest('second'), expectedAnswer: digest('answer'),
      history: [{ rating: 'partial', comment: digest('first') }, { rating: 'incorrect', comment: digest('second') }],
    });
  });

  it('keeps runs.userVerdict equal to the stored rating when two runtimes rate at once and the store is slow', async () => {
    const memory = createInMemoryStore();
    const SLOW_READ_MS = 30;
    let isFirstRunRead = true;
    let markFirstFeedbackWritten: () => void = () => undefined;
    const firstFeedbackWritten = new Promise<void>(resolve => { markFirstFeedbackWritten = resolve; });
    const store: Store = {
      ...memory,
      // The first read of the run record (by the first rating) is slow, so the second rating overtakes it.
      get: async (collection, key) => {
        if (collection === 'runs' && isFirstRunRead) { isFirstRunRead = false; await new Promise(resolve => setTimeout(resolve, SLOW_READ_MS)); }
        return memory.get(collection, key);
      },
      compareAndSet: async params => { const stored = await memory.compareAndSet(params); if (stored && params.collection === 'feedback') markFirstFeedbackWritten(); return stored; },
    };
    const { ai, agent } = setup({ store });
    const result = await agent.task({ task: 'x' });
    const second = createAigent({ providers: [createFakeProvider({ turns: [] })], store });
    const first = ai.feedback({ responseId: result.responseId, rating: 'incorrect' });
    await firstFeedbackWritten;
    await Promise.all([first, second.feedback({ responseId: result.responseId, rating: 'correct' })]);
    const feedback = await userFeedback(store, result.responseId);
    expect(feedback?.history.map(({ rating }) => rating)).toEqual(['incorrect', 'correct']);
    expect((await memory.get<RunRecord>('runs', result.runId))?.value.userVerdict).toBe(feedback?.rating);
  });

  it('ai.close() waits for ai.feedback calls in flight, so their verdict is not lost at shutdown', async () => {
    const memory = createInMemoryStore();
    const SLOW_READ_MS = 20;
    const store: Store = { ...memory, get: async (collection, key) => { if (collection === 'responses') await new Promise(resolve => setTimeout(resolve, SLOW_READ_MS)); return memory.get(collection, key); } };
    const { ai, agent } = setup({ store });
    const result = await agent.task({ task: 'x' });
    const pending = ai.feedback({ responseId: result.responseId, rating: 'incorrect' });
    await ai.close();
    expect((await memory.get<RunRecord>('runs', result.runId))?.value.userVerdict).toBe('incorrect');
    await pending;
  });

  it('stores no comment or expected answer text with captureContent: false, only their lengths', async () => {
    const { ai, agent, store } = setup({ options: { captureContent: false } });
    const result = await agent.task({ task: 'x' });
    const comment = `It leaked ${SECRET}`;
    await ai.feedback({ responseId: result.responseId, rating: 'incorrect', comment, expectedAnswer: SECRET });
    const stored = await userFeedback(store, result.responseId);
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(stored).toMatchObject({ rating: 'incorrect', commentLength: comment.length, expectedAnswerLength: SECRET.length, history: [{ rating: 'incorrect', commentLength: comment.length }] });
    expect(stored).not.toHaveProperty('comment');
    expect(stored).not.toHaveProperty('expectedAnswer');
  });
});
