import { describe, expect, it } from 'vitest';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { createShellPolicy } from '../../../security/shell-policy.js';
import { withProcessSlot } from './shell-shared.js';

const policy = createShellPolicy({ commands: [{ name: 'node', resolvedPath: process.execPath }], cwdPolicy: createFsPolicy({ roots: [] }), maxConcurrent: 1 });

describe('withProcessSlot', () => {
  it('stops waiting for a slot when its signal aborts, without starting the work or losing the slot', async () => {
    let release: () => void = () => undefined;
    const holder = withProcessSlot({ policy, work: () => new Promise<string>(resolve => { release = () => resolve('first'); }) });
    const controller = new AbortController();
    let isStarted = false;
    const waiter = withProcessSlot({ policy, signal: controller.signal, work: async () => { isStarted = true; return 'second'; } });
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ isToolFailure: true, init: { code: 'aborted', category: 'aborted' } });
    release();
    expect(await holder).toBe('first');
    expect(isStarted).toBe(false);
    // The slot was handed back, not to the aborted waiter: the next start runs at once.
    expect(await withProcessSlot({ policy, work: async () => 'third' })).toBe('third');
  });

  it('refuses at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withProcessSlot({ policy, signal: controller.signal, work: async () => 'never' })).rejects.toMatchObject({ init: { code: 'aborted' } });
  });
});
