import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createEmptyConversation } from './conversation.js';
import { reduceConversation } from './reduce-conversation.js';
import type { Patch, PatchBody } from './patches.js';
import { referenceBuild } from './reference-builder.test-support.js';
import { jsonRoundTrip, SESSION, testMessage } from './chat-model.test-support.js';

/** One random step; `pick` chooses among the messages that exist at that point. */
type Op =
  | { kind: 'add'; text: string }
  | { kind: 'delta'; pick: number; text: string }
  | { kind: 'finish'; pick: number }
  | { kind: 'interrupt'; pick: number }
  | { kind: 'pin'; pick: number; pinned: boolean }
  | { kind: 'remove'; pick: number }
  | { kind: 'status'; status: 'idle' | 'running' | 'waiting_for_user' }
  | { kind: 'title'; text: string }
  | { kind: 'queue'; texts: string[] }
  | { kind: 'branch'; pick: number };

const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('add' as const), text: fc.string() }),
  fc.record({ kind: fc.constant('delta' as const), pick: fc.nat(), text: fc.string({ minLength: 1 }) }),
  fc.record({ kind: fc.constant('finish' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('interrupt' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('pin' as const), pick: fc.nat(), pinned: fc.boolean() }),
  fc.record({ kind: fc.constant('remove' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('status' as const), status: fc.constantFrom('idle' as const, 'running' as const, 'waiting_for_user' as const) }),
  fc.record({ kind: fc.constant('title' as const), text: fc.string() }),
  fc.record({ kind: fc.constant('queue' as const), texts: fc.array(fc.string(), { maxLength: 3 }) }),
  fc.record({ kind: fc.constant('branch' as const), pick: fc.nat() }),
);

/** Turns random ops into a valid patch stream: steps that need a message are skipped while none exists. */
function toPatches(ops: Op[]): Patch[] {
  const ids: string[] = [];
  const bodies: PatchBody[] = [];
  let created = 0;
  for (const op of ops) {
    if (op.kind === 'add') { created += 1; const id = `m${created}`; ids.push(id); bodies.push({ type: 'message-added', message: testMessage(id, { parts: [{ type: 'text', text: op.text }], state: 'streaming' }) }); continue; }
    if (op.kind === 'status') { bodies.push({ type: 'status-changed', status: op.status }); continue; }
    if (op.kind === 'title') { bodies.push({ type: 'title-updated', title: op.text }); continue; }
    if (op.kind === 'queue') { bodies.push({ type: 'queue-updated', queue: op.texts.map((text, index) => ({ id: `q${index}`, text, queuedAt: index })) }); continue; }
    const messageId = ids[op.pick % Math.max(ids.length, 1)];
    if (messageId == null) continue;
    if (op.kind === 'delta') bodies.push({ type: 'message-updated', messageId, delta: op.text });
    if (op.kind === 'finish') bodies.push({ type: 'message-updated', messageId, set: { state: 'complete', completedAt: 7 } });
    if (op.kind === 'interrupt') bodies.push({ type: 'message-interrupted', messageId });
    if (op.kind === 'pin') bodies.push({ type: 'pinned-updated', messageId, pinned: op.pinned });
    if (op.kind === 'branch') bodies.push({ type: 'branch-created', branch: { id: `b${bodies.length}`, parentBranchId: 'main', baseMessageId: messageId, reason: 'edit', createdAt: 3 } });
    if (op.kind === 'remove') { bodies.push({ type: 'message-removed', messageId }); ids.splice(ids.indexOf(messageId), 1); }
  }
  return bodies.map((body, index) => ({ ...body, seq: index + 1, at: 1_000 + index }) as Patch);
}

describe('reduceConversation (property)', () => {
  it('folding any valid patch stream from empty equals the reference builder, for every prefix', () => {
    fc.assert(fc.property(fc.array(opArbitrary, { maxLength: 40 }), ops => {
      const empty = createEmptyConversation(SESSION);
      const patches = toPatches(ops);
      let state = empty;
      patches.forEach((patch, index) => {
        state = reduceConversation(state, patch);
        expect(state).toEqual(referenceBuild(empty, patches.slice(0, index + 1)));
      });
      expect(jsonRoundTrip(state)).toEqual(state);
      // Re-delivering the whole stream changes nothing.
      expect(patches.reduce(reduceConversation, state)).toBe(state);
    }), { numRuns: 200 });
  });
});
