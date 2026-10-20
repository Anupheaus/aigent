import { describe, expect, it } from 'vitest';
import type { AgentFeedbackRecord, StoredAgentFeedbackEntry } from '../feedback/feedback-records.js';
import { MAX_RECENT_AGENT_FEEDBACK, summariseAgentFeedback } from './agent-feedback-summary.js';

function record(params: { runId: string; recordedAt: number; entry: StoredAgentFeedbackEntry; agentName?: string; index?: number }): AgentFeedbackRecord {
  const { runId, recordedAt, entry, agentName = 'helper', index = 0 } = params;
  return { schemaVersion: 1, runId, agentName, instanceId: 'i1', mode: 'task', agentVersion: 'v1', recordedAt, kind: 'agent', callId: 'f1', index, entry };
}

describe('summariseAgentFeedback', () => {
  it('counts entries per agent by kind and by related tool, most frequent first, and quotes the newest texts', () => {
    const records = [
      record({ runId: 'r1', recordedAt: 1, entry: { kind: 'hard', text: 'Search was slow', relatedTool: 'search' } }),
      record({ runId: 'r2', recordedAt: 2, entry: { kind: 'hard', text: 'Search timed out', relatedTool: 'search' } }),
      record({ runId: 'r2', recordedAt: 2, index: 1, entry: { kind: 'missing', textLength: 12 } }),
      record({ runId: 'r3', recordedAt: 3, entry: { kind: 'easy', text: 'Read is clear', relatedTool: 'read' } }),
      record({ runId: 'r9', recordedAt: 3, agentName: 'other', entry: { kind: 'simplify', text: 'x' } }),
    ];
    expect(summariseAgentFeedback({ records, runIds: new Set(['r1', 'r2', 'r3', 'r9']) })).toEqual([
      {
        agentName: 'helper', total: 4,
        byKind: [{ kind: 'hard', count: 2 }, { kind: 'easy', count: 1 }, { kind: 'missing', count: 1 }],
        byTool: [{ tool: 'search', count: 2, byKind: [{ kind: 'hard', count: 2 }] }, { tool: 'read', count: 1, byKind: [{ kind: 'easy', count: 1 }] }],
        recent: [
          { runId: 'r3', recordedAt: 3, kind: 'easy', relatedTool: 'read', text: 'Read is clear' },
          { runId: 'r2', recordedAt: 2, kind: 'hard', relatedTool: 'search', text: 'Search timed out' },
          { runId: 'r1', recordedAt: 1, kind: 'hard', relatedTool: 'search', text: 'Search was slow' },
        ],
      },
      { agentName: 'other', total: 1, byKind: [{ kind: 'simplify', count: 1 }], byTool: [], recent: [{ runId: 'r9', recordedAt: 3, kind: 'simplify', text: 'x' }] },
    ]);
  });

  it('only counts entries of the report\'s runs', () => {
    const records = [record({ runId: 'r1', recordedAt: 1, entry: { kind: 'easy', text: 'a' } }), record({ runId: 'r2', recordedAt: 2, entry: { kind: 'hard', text: 'b' } })];
    expect(summariseAgentFeedback({ records, runIds: new Set(['r2']) }).map(({ total, recent }) => [total, recent.map(({ text }) => text)])).toEqual([[1, ['b']]]);
  });

  it(`caps the quoted texts at ${MAX_RECENT_AGENT_FEEDBACK}, newest first, while counting every entry`, () => {
    const records = Array.from({ length: MAX_RECENT_AGENT_FEEDBACK + 5 }, (_, position) => record({ runId: `r${position}`, recordedAt: position, entry: { kind: 'suggestion', text: `t${position}` } }));
    const [summary] = summariseAgentFeedback({ records, runIds: new Set(records.map(({ runId }) => runId)) });
    expect(summary?.total).toBe(MAX_RECENT_AGENT_FEEDBACK + 5);
    expect(summary?.recent).toHaveLength(MAX_RECENT_AGENT_FEEDBACK);
    expect(summary?.recent[0]?.text).toBe(`t${MAX_RECENT_AGENT_FEEDBACK + 4}`);
  });

  it('is empty without entries', () => {
    expect(summariseAgentFeedback({ records: [], runIds: new Set() })).toEqual([]);
  });
});
