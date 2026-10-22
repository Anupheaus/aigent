import type { Usage } from '@anupheaus/aigent';
import type { BridgedTool, ClaudeAgentRunParams, ClaudeAgentRunner, SdkMessage } from './sdk-boundary.js';

/** One scripted step of a fake Claude Code run. */
export type FakeStep =
  | { kind: 'message'; message: SdkMessage }
  /** Calls a bridged tool the way the SDK calls an in-process MCP tool; its result is recorded. */
  | { kind: 'call'; tool: string; args: unknown }
  | { kind: 'wait'; ms: number }
  /** Waits until the run's signal aborts (then ends quietly, as the SDK does when its subprocess is killed). */
  | { kind: 'hang' }
  | { kind: 'throw'; message: string };

export interface FakeRunner extends ClaudeAgentRunner {
  /** Every run's parameters, in order. */
  runs: ClaudeAgentRunParams[];
  /** Results of bridged calls, in order. */
  toolResults: { tool: string; text: string; isError: boolean }[];
  /** Whether a run was closed early (the consumer stopped iterating or aborted). */
  closedEarly: boolean[];
}

export function textDelta(text: string): FakeStep {
  return { kind: 'message', message: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } } };
}

export function thinkingDelta(thinking: string): FakeStep {
  return { kind: 'message', message: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } } } };
}

export function stopReason(reason: string): FakeStep {
  return { kind: 'message', message: { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: reason } } } };
}

/** A successful `result` carrying `usage` in the SDK's snake_case fields (cached reads split out of input). */
export function resultStep(usage: Usage, subtype = 'success'): FakeStep {
  const { inputTokens, outputTokens, cachedTokens } = usage;
  return { kind: 'message', message: { type: 'result', subtype, num_turns: 1, usage: { input_tokens: inputTokens - cachedTokens, output_tokens: outputTokens, cache_read_input_tokens: cachedTokens, cache_creation_input_tokens: 0 } } };
}

function findTool(params: { tools: BridgedTool[]; name: string }): BridgedTool {
  const tool = params.tools.find(({ name }) => name === params.name);
  if (tool == null) throw new Error(`fake runner: no bridged tool '${params.name}' (have ${params.tools.map(({ name }) => name).join(', ')})`);
  return tool;
}

/** A Claude Code stand-in: each `run` plays the next script (one per run). */
export function createFakeRunner(scripts: FakeStep[][]): FakeRunner {
  const runs: ClaudeAgentRunParams[] = [];
  const toolResults: FakeRunner['toolResults'] = [];
  const closedEarly: boolean[] = [];
  return {
    runs, toolResults, closedEarly,
    run(params) {
      runs.push(params);
      const script = scripts.shift() ?? [];
      const index = closedEarly.push(false) - 1;
      return (async function* play(): AsyncGenerator<SdkMessage> {
        let isComplete = false;
        try {
          for (const step of script) {
            if (step.kind === 'message') yield step.message;
            if (step.kind === 'wait') await new Promise(resolve => setTimeout(resolve, step.ms));
            if (step.kind === 'throw') throw new Error(step.message);
            if (step.kind === 'hang') await new Promise(resolve => params.signal.addEventListener('abort', resolve, { once: true }));
            if (step.kind === 'call') toolResults.push({ tool: step.tool, ...(await findTool({ tools: params.tools, name: step.tool }).execute(step.args)) });
          }
          isComplete = true;
        } finally {
          if (!isComplete) closedEarly[index] = true;
        }
      })();
    },
  };
}
