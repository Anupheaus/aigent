import { z } from 'zod';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import type { FeedbackCollector } from './feedback-collector.js';
import { AGENT_FEEDBACK_KINDS } from './feedback-records.js';
import type { AgentFeedbackEntry } from './feedback-records.js';

export const FEEDBACK_TOOL_NAME = 'aigent_feedback';
const MAX_FEEDBACK_ENTRIES = 10;
const MAX_FEEDBACK_TEXT_LENGTH = 500;
const MAX_RELATED_TOOL_LENGTH = 64;

const feedbackArgsSchema = z.object({
  entries: z.array(z.object({
    kind: z.enum(AGENT_FEEDBACK_KINDS),
    text: z.string().min(1).max(MAX_FEEDBACK_TEXT_LENGTH),
    relatedTool: z.string().min(1).max(MAX_RELATED_TOOL_LENGTH).optional(),
  }).strict()).min(1).max(MAX_FEEDBACK_ENTRIES),
}).strict();

export interface CreateFeedbackToolParams {
  /** Receives every entry; they are stored with the run's records. */
  collector: FeedbackCollector;
}

/** Built-in tool through which the agent reports what was easy, hard, missing or could be simpler. Registered only when feedback is enabled. */
export function createFeedbackTool(params: CreateFeedbackToolParams): Tool {
  const { collector } = params;
  return defineTool({
    name: FEEDBACK_TOOL_NAME,
    description: 'Report what was easy, hard, missing or could be simpler in this task (kinds: easy, hard, suggestion, missing, simplify), optionally naming the tool concerned. Up to 10 entries per call.',
    args: feedbackArgsSchema,
    deterministic: false,
    cache: false,
    describeActivity: ({ entries }) => ({ title: `Recording ${entries.length} feedback entries`, detail: entries.map(({ kind }) => kind).join(', ') }),
    run: async ({ entries }, { runId, callId }) => {
      entries.forEach((entry: AgentFeedbackEntry, index) => collector.add({ runId, callId, index, entry }));
      return { recorded: entries.length };
    },
  });
}
