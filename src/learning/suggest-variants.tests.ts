import { describe, expect, it } from 'vitest';
import type { Finding } from '../scoring/report-types.js';
import { suggestVariants } from './suggest-variants.js';

function finding(params: Pick<Finding, 'kind' | 'subject'> & { agentName?: string }): Finding {
  const { kind, subject, agentName = 'helper' } = params;
  return { id: `${kind}:${agentName}:${subject}`, kind, severity: 'warn', label: 'inefficient', agentName, subject, message: 'm', evidence: {} };
}

describe('suggestVariants', () => {
  const toolDescriptions = new Map([['read', 'Read a file'], ['search', 'Search files']]);

  it('turns findings into fixed-template candidates', () => {
    const { suggested, skipped } = suggestVariants({
      findings: [finding({ kind: 'unbatched-repeats', subject: 'read' }), finding({ kind: 'verbose-tool', subject: 'search' }), finding({ kind: 'slow-tool', subject: 'read' }), finding({ kind: 'too-many-turns', subject: 'run_1' })],
      agentName: 'helper', toolDescriptions,
    });
    expect(skipped).toEqual([]);
    expect(suggested).toEqual([
      { source: 'slow-tool:helper:read', proposal: { label: 'Describe read (slow-tool)', changes: [{ kind: 'tool-description', tool: 'read', text: 'Read a file It is slow: call it only when you need it, and batch its calls.' }] } },
      { source: 'unbatched-repeats:helper:read', proposal: { label: 'Batch read calls', changes: [{ kind: 'batching-hint', text: expect.stringContaining('Call read once for all the items') }] } },
      { source: 'verbose-tool:helper:search', proposal: { label: 'Describe search (verbose-tool)', changes: [{ kind: 'tool-description', tool: 'search', text: 'Search files Its results are long: ask only for what you need.' }] } },
    ]);
  });

  it('reports findings about tools the agent lacks, and ignores other agents', () => {
    const { suggested, skipped } = suggestVariants({ findings: [finding({ kind: 'slow-tool', subject: 'ghost' }), finding({ kind: 'slow-tool', subject: 'read', agentName: 'other' })], agentName: 'helper', toolDescriptions });
    expect(suggested).toEqual([]);
    expect(skipped).toEqual([{ source: 'slow-tool:helper:ghost', reason: "the agent has no tool 'ghost'" }]);
  });
});
