import { describe, expect, it } from 'vitest';
import { createFakeProvider, textTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';
import type { ThinkingContext } from './run-callbacks.js';
import type { RunCallbacks } from './run-callbacks.js';

const THINKING: FakeTurn = { events: [{ type: 'thinking-delta', text: 'Hmm, ' }, { type: 'thinking-delta', text: 'say ok' }, ...textTurn('ok').events] };

function setup(turns: FakeTurn[]) {
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], enableFeedback: false });
  return { agent: ai.agent({ name: 'a', model: 'fake:m', modelSettings: { showThinking: false } }) };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** Every thinking stream the callback is handed, read to the end. */
function recordThinking(run: RunCallbacks): () => Promise<{ text: string; context: ThinkingContext }[]> {
  const pending: Promise<{ text: string; context: ThinkingContext }>[] = [];
  run.onThinking((thinking, context) => {
    pending.push((async () => { let text = ''; for await (const delta of thinking) text += delta; return { text, context }; })());
  });
  return () => Promise.all(pending);
}

describe('onThinking with showThinking: false', () => {
  it('still hands a task the full reasoning (with provider and model), while the event stream carries none', async () => {
    const { agent } = setup([THINKING]);
    const run = agent.task({ task: 'think' });
    const thoughts = recordThinking(run);
    const events = await collect(run);
    expect(events.filter(({ type }) => type === 'thinking-delta' || type === 'thinking-done')).toEqual([]);
    expect(await thoughts()).toEqual([{ text: 'Hmm, say ok', context: { runId: run.runId, turn: 1, provider: 'fake', model: 'm' } }]);
  });

  it('still hands a chat turn the reasoning, while the message gets no thinking part', async () => {
    const { agent } = setup([THINKING]);
    const chat = agent.chat();
    const turn = chat.send('think');
    const thoughts = recordThinking(turn);
    await turn;
    expect((await thoughts()).map(({ text, context: { messageId } }) => ({ text, messageId }))).toEqual([{ text: 'Hmm, say ok', messageId: turn.messageId }]);
    const reply = chat.conversation().messages.find(({ id }) => id === turn.messageId)!;
    expect(reply.parts.some(({ type }) => type === 'thinking')).toBe(false);
  });
});
