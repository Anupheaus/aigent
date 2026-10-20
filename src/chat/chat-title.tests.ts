import { describe, expect, it } from 'vitest';
import { createScheduler } from '../scheduler/scheduler.js';
import type { LeaseRequest, Scheduler } from '../scheduler/scheduler-types.js';
import { textTurn } from '../testing/fake-provider.js';
import { chatSetup } from './chat.test-support.js';

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
}

const CLOSE_LIMIT_MS = 500;
const STALLED_MS = 5_000;

/** A real scheduler that records every lease request. */
function recordingScheduler(): Scheduler & { requests: LeaseRequest[] } {
  const scheduler = createScheduler({});
  const requests: LeaseRequest[] = [];
  return { ...scheduler, requests, acquire: request => { requests.push(request); return scheduler.acquire(request); } };
}

describe('autoTitle', () => {
  it('takes a background scheduler lease for the title call', async () => {
    const scheduler = recordingScheduler();
    const { agent } = chatSetup({ turns: [textTurn('hi'), textTurn('Greeting chat')], runtime: { scheduler } });
    const chat = agent.chat({ autoTitle: true });
    await chat.send('hello');
    await until(() => chat.conversation().title != null);
    await chat.close();
    expect(chat.conversation().title).toBe('Greeting chat');
    expect(scheduler.requests.map(({ priority }) => priority)).toEqual(['interactive', 'background']);
  });

  it('does not hold up close() when the title call stalls: close aborts it and the session stays untitled', async () => {
    const { agent } = chatSetup({ turns: [textTurn('hi'), textTurn('Never arrives', { delayMs: STALLED_MS })] });
    const chat = agent.chat({ autoTitle: true });
    await chat.send('hello');
    const started = Date.now();
    await chat.close();
    expect(Date.now() - started).toBeLessThan(CLOSE_LIMIT_MS);
    expect(chat.conversation().title).toBeUndefined();
  });

  it('keeps a single title call in flight across quick replies', async () => {
    const { agent, provider } = chatSetup({ turns: [textTurn('hi'), textTurn('Greeting chat', { delayMs: 30 }), textTurn('second'), textTurn('Another title')] });
    const chat = agent.chat({ autoTitle: true });
    await chat.send('hello');
    await chat.send('more');
    await until(() => chat.conversation().title != null);
    await chat.close();
    expect(provider.requests).toHaveLength(3);
    expect(chat.conversation().title).toBe('Greeting chat');
  });
});
