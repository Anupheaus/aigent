import { createAigentError } from '../../core/aigent-error.js';
import { createFakeFetch } from '../../providers/fake-fetch.test-support.js';
import { openAiCompatible } from '../../providers/openai-compatible.js';
import { openAiScenarioResponse } from '../../providers/openai-fixtures.test-support.js';
import type { Provider } from '../../providers/provider-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../fake-provider.js';
import type { FakeTurn } from '../fake-provider.js';
import { describeProviderContract } from './provider-contract.js';
import type { ContractScenario } from './provider-contract.js';

/** Delay between fake events so an abort reliably lands mid-stream. */
const SLOW_DELAY_MS = 20;
const FALLBACK_USAGE = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

function fakeTurnFor(scenario: ContractScenario): FakeTurn {
  switch (scenario.kind) {
    case 'text':
      return textTurn(scenario.chunks.join(''), { usage: scenario.usage, chunkSize: 1 });
    case 'tool-calls':
      return toolTurn(scenario.calls, { usage: scenario.usage });
    case 'malformed-tool-args':
      return toolTurn([{ id: 'call_malformed', name: scenario.name, args: scenario.rawArgs }], { usage: FALLBACK_USAGE });
    case 'slow-text':
      return textTurn(scenario.chunks.join(''), { chunkSize: 1, delayMs: SLOW_DELAY_MS });
    case 'http-error':
    case 'truncated-stream':
      // Skipped below: the fake has no HTTP layer and plays scripted events verbatim.
      throw createAigentError({ code: 'invalid_input', message: `FakeProvider cannot model contract scenario '${scenario.kind}'` });
  }
}

describeProviderContract({
  name: 'FakeProvider',
  create: (scenario): Provider => createFakeProvider({ turns: [fakeTurnFor(scenario)] }),
  skip: ['http-error', 'truncated-stream'],
});

describeProviderContract({
  name: 'openAiCompatible',
  create: (scenario): Provider => {
    const { fetch } = createFakeFetch(() => openAiScenarioResponse(scenario));
    return openAiCompatible({ id: 'contract-openai', baseUrl: 'https://llm.test/v1', apiKey: 'sk-contract', fetch });
  },
});
