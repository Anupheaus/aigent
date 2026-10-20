// Live tests against real model servers. Skipped unless AIGENT_LIVE=1, and each provider also needs its own key or
// server, so the default suite never touches the network. See README "Live tests" for the variables.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAigent } from '../core/create-aigent.js';
import type { TaskResult } from '../core/agent-types.js';
import { defineTool } from '../tools/define-tool.js';
import { anthropic } from './anthropic.js';
import { deepseek, ollama } from './presets.js';
import type { Provider } from './provider-types.js';

const { AIGENT_LIVE, OLLAMA_MODEL, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, ANTHROPIC_MODEL } = process.env;
const IS_LIVE = AIGENT_LIVE === '1';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:14b';
const DEEPSEEK_MODEL = 'deepseek-chat';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';
const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags';
const OLLAMA_PROBE_TIMEOUT_MS = 2_000;
/** Real models (and a local 14B model on CPU) can be slow; generous so only real failures fail. */
const LIVE_TEST_TIMEOUT_MS = 180_000;
const MAX_TURNS = 5;
const FIRST_ADDEND = 1234;
const SECOND_ADDEND = 5678;

/** An empty variable (e.g. `ANTHROPIC_API_KEY=`) counts as unset, so it skips rather than failing with a 401. */
function isSet(value: string | undefined): value is string {
  return value != null && value !== '';
}

const addTool = defineTool({
  name: 'add',
  description: 'Adds two integers and returns their sum. Always use this tool for arithmetic.',
  args: z.object({ a: z.number().int(), b: z.number().int() }).strict(),
  deterministic: true,
  cache: false,
  describeActivity: ({ a, b }) => ({ title: `Adding ${a} + ${b}` }),
  run: async ({ a, b }) => a + b,
});

/** Runs one tiny tool-using task and closes the instance, so no run outlives the test. */
async function runAdditionTask(params: { provider: Provider; model: string }): Promise<TaskResult> {
  const { provider, model } = params;
  const ai = createAigent({ providers: [provider] });
  const agent = ai.agent({ name: 'live-check', model: `${provider.id}:${model}`, tools: [addTool], limits: { maxTurns: MAX_TURNS } });
  const result = await agent.task({ task: `Use the add tool to compute ${FIRST_ADDEND} + ${SECOND_ADDEND}, then reply with only the sum.` });
  await ai.close();
  return result;
}

/** True when a local Ollama server answers; the Ollama test is skipped (not failed) without one. */
async function isOllamaRunning(): Promise<boolean> {
  try {
    const response = await fetch(OLLAMA_TAGS_URL, { signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS) });
    return response.ok;
  } catch {
    // Connection refused or timed out: no server, so there is nothing to test against.
    return false;
  }
}

function expectToolUsingCompletion(result: TaskResult): void {
  // `failure` in the message makes a provider error readable straight from the test output.
  expect(result.status, result.failure).toBe('completed');
  expect(result.usage.toolCalls).toBeGreaterThanOrEqual(1);
}

describe.skipIf(!IS_LIVE)('live providers', () => {
  describe('ollama', () => {
    it('completes a tool-using task', { timeout: LIVE_TEST_TIMEOUT_MS }, async context => {
      if (!(await isOllamaRunning())) context.skip(`no Ollama server answered ${OLLAMA_TAGS_URL}`);
      expectToolUsingCompletion(await runAdditionTask({ provider: ollama(), model: OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL }));
    });
  });

  describe('deepseek', () => {
    it.skipIf(!isSet(DEEPSEEK_API_KEY))('completes a tool-using task', { timeout: LIVE_TEST_TIMEOUT_MS }, async () => {
      expectToolUsingCompletion(await runAdditionTask({ provider: deepseek({ apiKey: DEEPSEEK_API_KEY }), model: DEEPSEEK_MODEL }));
    });
  });

  describe('anthropic', () => {
    it.skipIf(!isSet(ANTHROPIC_API_KEY))('completes a tool-using task', { timeout: LIVE_TEST_TIMEOUT_MS }, async () => {
      const provider = anthropic({ apiKey: ANTHROPIC_API_KEY ?? '' });
      expectToolUsingCompletion(await runAdditionTask({ provider, model: ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL }));
    });
  });
});
