import { describe, expect, it } from 'vitest';
import { routeDelivery } from './delivery.js';
import { createSteerInbox } from './steer-inbox.js';

describe('routeDelivery', () => {
  it.each([
    ['queue', false, false, 'start'],
    ['steer', false, false, 'start'],
    ['interrupt', false, true, 'queue'],
    ['queue', true, false, 'queue'],
    ['steer', true, false, 'steer'],
    ['interrupt', true, true, 'interrupt'],
  ] as const)('%s with busy=%s and a queue=%s', (mode, isBusy, hasQueue, expected) => {
    expect(routeDelivery({ mode, isBusy, hasQueue })).toBe(expected);
  });
});

describe('createSteerInbox', () => {
  it('delivers everything pushed so far once, in order, and drains what was never delivered', () => {
    const delivered: string[][] = [];
    const inbox = createSteerInbox<string>({ toMessage: text => ({ role: 'user', text }), onDeliver: entries => delivered.push(entries) });
    expect(inbox.take()).toEqual([]);
    inbox.push('a');
    inbox.push('b');
    expect(inbox.take()).toEqual([{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }]);
    expect(inbox.take()).toEqual([]);
    inbox.push('c');
    expect(inbox.drain()).toEqual(['c']);
    expect(inbox.take()).toEqual([]);
    expect(delivered).toEqual([['a', 'b']]);
  });
});
