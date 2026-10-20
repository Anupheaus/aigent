import { describe, expect, it, vi } from 'vitest';
import { createPatchLog } from './apply-patch.js';
import { createEmptyConversation } from './conversation.js';
import { reduceConversation } from './reduce-conversation.js';
import { SESSION, testMessage } from './chat-model.test-support.js';

function setup() {
  let now = 10;
  const log = createPatchLog({ base: createEmptyConversation(SESSION), now: () => (now += 1) });
  return { log };
}

describe('createPatchLog', () => {
  it('stamps gapless seqs and times and keeps the snapshot equal to the folded stream', () => {
    const { log } = setup();
    log.append({ type: 'message-added', message: testMessage('m1') });
    log.append({ type: 'message-updated', messageId: 'm1', delta: 'hi' });
    log.append({ type: 'status-changed', status: 'running' });
    expect(log.patches().map(({ seq, at }) => [seq, at])).toEqual([[1, 11], [2, 12], [3, 13]]);
    expect(log.patches().reduce(reduceConversation, createEmptyConversation(SESSION))).toEqual(log.state());
  });

  it('returns exactly the patches from a seq on, and replays them to a late subscriber', () => {
    const { log } = setup();
    log.append({ type: 'title-updated', title: 'a' });
    log.append({ type: 'title-updated', title: 'b' });
    log.append({ type: 'title-updated', title: 'c' });
    expect(log.patches(2).map(({ seq }) => seq)).toEqual([2, 3]);
    const seen: number[] = [];
    const unsubscribe = log.subscribe(patch => seen.push(patch.seq), { fromSeq: 3 });
    log.append({ type: 'title-updated', title: 'd' });
    unsubscribe();
    log.append({ type: 'title-updated', title: 'e' });
    expect(seen).toEqual([3, 4]);
  });

  it('keeps going when a listener throws', () => {
    const { log } = setup();
    const after = vi.fn();
    log.subscribe(() => { throw new Error('ui bug'); });
    log.subscribe(after);
    log.append({ type: 'title-updated', title: 'x' });
    expect(after).toHaveBeenCalledTimes(1);
    expect(log.state().title).toBe('x');
  });

  it('rejects a patch the reducer refuses without recording it', () => {
    const { log } = setup();
    expect(() => log.append({ type: 'message-updated', messageId: 'missing', delta: 'x' })).toThrow(/unknown message/);
    expect(log.patches()).toEqual([]);
    expect(log.state().seq).toBe(0);
  });

  it('restores from stored patches', () => {
    const { log } = setup();
    log.append({ type: 'title-updated', title: 'a' });
    const restored = createPatchLog({ base: createEmptyConversation(SESSION), history: log.patches(), now: () => 50 });
    expect(restored.state()).toEqual(log.state());
    expect(restored.append({ type: 'title-updated', title: 'b' }).seq).toBe(2);
  });
});
