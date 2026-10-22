import { describeProviderContract } from '@anupheaus/aigent/testing/contract';
import type { ContractScenario } from '@anupheaus/aigent/testing/contract';
import type { Provider } from '@anupheaus/aigent';
import { claudeCode } from './claude-code-provider.js';
import { createFakeRunner, resultStep, stopReason, textDelta, thinkingDelta } from './fake-runner.test-support.js';
import type { FakeStep } from './fake-runner.test-support.js';

/** The SDK stream a real Claude Code run would produce for each scenario. */
function stepsFor(scenario: ContractScenario): FakeStep[] {
  switch (scenario.kind) {
    case 'text': return [...scenario.chunks.map(textDelta), resultStep(scenario.usage)];
    case 'thinking': return [...scenario.thinking.map(thinkingDelta), ...scenario.chunks.map(textDelta), resultStep(scenario.usage)];
    case 'length': return [...scenario.chunks.map(textDelta), stopReason('max_tokens'), resultStep(scenario.usage)];
    case 'network-error': return [...scenario.chunks.map(textDelta), { kind: 'throw', message: 'Claude Code exited unexpectedly' }];
    case 'truncated-stream': return [textDelta('partial')];
    case 'slow-text': return [...scenario.chunks.flatMap((chunk): FakeStep[] => [{ kind: 'wait', ms: scenario.delayMs }, textDelta(chunk)]), resultStep({ inputTokens: 1, outputTokens: 1, cachedTokens: 0 })];
    default: return [];
  }
}

// Skipped, by design: tool calls never surface as `tool-call` events in delegated mode (the SDK's loop hands them to
// the bridge, which runs them through the core's executor); there is no HTTP layer of ours to fail; and thinking
// blocks are not replayed (each turn is a fresh SDK run).
describeProviderContract({
  name: 'claudeCode (fake runner)',
  create: (scenario): Provider => claudeCode({ runner: createFakeRunner([stepsFor(scenario)]) }),
  skip: ['tool-calls', 'malformed-tool-args', 'http-error', 'thinking-round-trip'],
});
