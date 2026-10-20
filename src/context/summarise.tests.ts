import { describe, expect, it } from 'vitest';
import { historyBuilder } from './compaction.test-support.js';
import { SUMMARISER_PROMPT, SUMMARY_HEADING, summaryMessageText, summaryRequestMessages } from './summarise.js';

describe('summariser request', () => {
  it('uses the fixed prompt asking for the structured sections', () => {
    expect(SUMMARISER_PROMPT).toContain('Goal, Decisions, Facts, Open items, Tool outcomes');
    expect(SUMMARISER_PROMPT).toContain('Keep negations and constraints exactly as stated');
  });

  it('renders the previous summary and every message, calls and results included', () => {
    const messages = historyBuilder().round({ callId: 'c1', text: 'file body' }).build();
    const [system, user] = summaryRequestMessages({ previousSummary: 'Goal: earlier', messages });
    expect(system).toEqual({ role: 'system', text: SUMMARISER_PROMPT });
    expect(user?.text).toBe('## Previous summary\nGoal: earlier\n\n## Conversation to summarise\n[assistant]\n[call c1] read {"path":"c1"}\n\n[result of call c1]\nfile body');
    expect(summaryRequestMessages({ messages }).at(1)?.text).not.toContain('Previous summary');
  });

  it('stores the summary under a runtime heading', () => {
    expect(summaryMessageText('  Goal: x \n')).toBe(`${SUMMARY_HEADING}\nGoal: x`);
  });
});
