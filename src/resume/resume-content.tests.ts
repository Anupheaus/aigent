import { describe, expect, it } from 'vitest';
import type { AigentEvent } from '../core/aigent-events.js';
import { createAigent } from '../core/create-aigent.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn } from '../testing/fake-provider.js';
import type { Redact } from '../telemetry/redact.js';
import { CALLS_COLLECTION, CHECKPOINTS_COLLECTION } from './checkpoint-types.js';
import { crashableStore, LEASE_TTL_MS } from './crash-injection.test-support.js';

const SECRET_TASK = 'Use the token SECRET-123 to sync';
const redactSecret: Redact = record => ({ ...record, value: JSON.parse(JSON.stringify(record.value).replaceAll('SECRET-123', '[redacted]')) });

describe('resume and stored content', () => {
  it('refuses resume together with captureContent: false, which forbids storing the content a resume needs', () => {
    expect(() => createAigent({ providers: [createFakeProvider({ turns: [] })], store: createInMemoryStore(), captureContent: false, resume: {} }))
      .toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('captureContent') }));
  });

  it('refuses resume with redact until checkpointRedaction says what checkpoints store', () => {
    expect(() => createAigent({ providers: [createFakeProvider({ turns: [] })], store: createInMemoryStore(), redact: redactSecret, resume: {} }))
      .toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('checkpointRedaction') }));
  });

  it("checkpointRedaction 'raw' stores checkpoints and the ledger unredacted, so the resumed prompt is the original", async () => {
    const store = createInMemoryStore();
    const ai = createAigent({ providers: [createFakeProvider({ turns: [textTurn('done')] })], store, enableFeedback: false, redact: redactSecret, resume: { lease: false, checkpointRedaction: 'raw' } });
    await ai.agent({ name: 'sync', model: 'fake:m', tools: [], instanceId: 'raw-1', todo: false }).task({ task: SECRET_TASK });
    await ai.close();
    expect(JSON.stringify(await store.list(CHECKPOINTS_COLLECTION))).toContain('SECRET-123');
  });

  it("checkpointRedaction 'redacted' redacts checkpoints, and a resume warns that its prompt is the redacted one", async () => {
    const base = createInMemoryStore();
    const process = crashableStore({ store: base });
    let now = 1_000;
    const options = { enableFeedback: false, redact: redactSecret, clock: { now: () => now }, resume: { lease: { ttlMs: LEASE_TTL_MS }, checkpointRedaction: 'redacted' as const } };
    const definition = { name: 'sync', model: 'fake:m', tools: [], instanceId: 'red-1', todo: false };
    // The first process dies once its run started: the model's answer never arrives.
    const dying = { ...createFakeProvider({ turns: [] }), stream: async function* stream(): AsyncGenerator<never> { process.crash(); throw new Error('process died'); } };
    const first = createAigent({ providers: [dying], store: process.store, ...options });
    await first.agent(definition).task({ task: SECRET_TASK }).then(() => undefined, () => undefined);
    await first.close().catch(() => undefined);
    expect(JSON.stringify([...await base.list(CHECKPOINTS_COLLECTION), ...await base.list(CALLS_COLLECTION)])).not.toContain('SECRET-123');
    now += LEASE_TTL_MS + 1;
    const provider = createFakeProvider({ turns: [textTurn('done')] });
    const second = createAigent({ providers: [provider], store: base, ...options });
    const agent = second.agent(definition);
    await agent.ready;
    const run = agent.resume()!;
    const events: AigentEvent[] = [];
    for await (const event of run) events.push(event);
    await second.close();
    expect(events).toContainEqual({ type: 'warning', message: expect.stringContaining('redacted') });
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain('[redacted]');
  });
});
