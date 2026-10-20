import { createAigentError } from '../../core/aigent-error.js';
import { anthropic } from '../../providers/anthropic.js';
import { anthropicScenarioResponse } from '../../providers/anthropic-fixtures.test-support.js';
import { createFakeFetch } from '../../providers/fake-fetch.test-support.js';
import type { FakeBody, FakeResponseSpec } from '../../providers/fake-fetch.test-support.js';
import { openAiCompatible } from '../../providers/openai-compatible.js';
import { openAiScenarioResponse } from '../../providers/openai-fixtures.test-support.js';
import type { Provider, ProviderEvent } from '../../providers/provider-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../fake-provider.js';
import type { FakeTurn } from '../fake-provider.js';
import { describeProviderContract } from './provider-contract.js';
import type { ContractObservation, ContractScenario } from './provider-contract.js';

const FALLBACK_USAGE = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

function fakeTurnFor(scenario: ContractScenario): FakeTurn {
  switch (scenario.kind) {
    case 'text':
      return textTurn(scenario.chunks.join(''), { usage: scenario.usage, chunkSize: 1 });
    case 'tool-calls':
      return toolTurn(scenario.calls, { usage: scenario.usage });
    case 'malformed-tool-args':
      return toolTurn([{ id: 'call_malformed', name: scenario.name, args: scenario.rawArgs }], { usage: FALLBACK_USAGE });
    case 'thinking': {
      const { thinking, chunks, usage } = scenario;
      const events: ProviderEvent[] = [
        ...thinking.map((text): ProviderEvent => ({ type: 'thinking-delta', text })),
        ...chunks.map((text): ProviderEvent => ({ type: 'text-delta', text })),
        { type: 'usage', usage },
        { type: 'done', finishReason: 'stop' },
      ];
      return { events };
    }
    case 'length': {
      const { chunks, usage } = scenario;
      return { events: [...chunks.map((text): ProviderEvent => ({ type: 'text-delta', text })), { type: 'usage', usage }, { type: 'done', finishReason: 'length' }] };
    }
    case 'slow-text':
      return textTurn(scenario.chunks.join(''), { chunkSize: 1, delayMs: scenario.delayMs });
    case 'http-error':
    case 'truncated-stream':
    case 'network-error':
      // Skipped below: the fake has no HTTP layer and plays scripted events verbatim.
      throw createAigentError({ code: 'invalid_input', message: `FakeProvider cannot model contract scenario '${scenario.kind}'` });
  }
}

describeProviderContract({
  name: 'FakeProvider',
  create: (scenario): Provider => createFakeProvider({ turns: [fakeTurnFor(scenario)] }),
  skip: ['http-error', 'truncated-stream', 'network-error'],
});

interface ObservedHttpSubject {
  /** A fake `fetch` serving `respond(scenario)` that remembers the body it served. */
  fetchFor(scenario: ContractScenario): typeof fetch;
  observe(): ContractObservation;
}

/** Remembers the last streamed body served, so the suite can check the provider cancelled it. */
function observedHttp(respond: (scenario: ContractScenario) => FakeResponseSpec): ObservedHttpSubject {
  let lastBody: FakeBody | undefined;
  return {
    fetchFor: scenario => createFakeFetch(() => {
      const spec = respond(scenario);
      lastBody = typeof spec.body === 'string' ? undefined : spec.body;
      return spec;
    }).fetch,
    observe: () => ({ isBodyCancelled: lastBody?.isCancelled() ?? false }),
  };
}

const openAiHttp = observedHttp(openAiScenarioResponse);

describeProviderContract({
  name: 'openAiCompatible',
  create: (scenario): Provider => openAiCompatible({ id: 'contract-openai', baseUrl: 'https://llm.test/v1', apiKey: 'sk-contract', fetch: openAiHttp.fetchFor(scenario) }),
  observe: openAiHttp.observe,
});

const anthropicHttp = observedHttp(anthropicScenarioResponse);

describeProviderContract({
  name: 'anthropic',
  create: (scenario): Provider => anthropic({ apiKey: 'sk-ant-contract', baseUrl: 'https://anthropic.test', fetch: anthropicHttp.fetchFor(scenario) }),
  observe: anthropicHttp.observe,
});
