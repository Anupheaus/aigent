import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAigent } from '../core/create-aigent.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';

describe('a graceful stop while an approval is pending', () => {
  it('ends the wait (the call is refused as aborted) and the run settles as stopped without running the tool', async () => {
    const ran: string[] = [];
    const wipe = defineTool({
      name: 'wipe', description: 'Wipe', args: z.object({}).strict(), deterministic: false, cache: false, hasSideEffects: true, requiresApproval: true,
      describeActivity: () => ({ title: 'wipe' }), run: async () => { ran.push('wipe'); return 'wiped'; },
    });
    const provider = createFakeProvider({ turns: [toolTurn([{ id: 'w1', name: 'wipe', args: {} }]), textTurn('done')] });
    const ai = createAigent({ providers: [provider], store: createInMemoryStore(), enableFeedback: false });
    const run = ai.agent({ name: 'wiper', model: 'fake:m', tools: [wipe], todo: false }).task({ task: 'wipe' });
    const results = [];
    for await (const event of run) {
      if (event.type === 'approval-request') run.stop({ mode: 'graceful' });
      if (event.type === 'tool-result') results.push(event.envelope);
    }
    const result = await run;
    await ai.close();
    expect(result.status).toBe('stopped');
    expect(ran).toEqual([]);
    expect(results).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'approval_aborted' }) })]);
    expect(provider.requests).toHaveLength(1);
  });
});
