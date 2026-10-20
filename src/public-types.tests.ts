import { describe, expect, it } from 'vitest';
import type {
  CompareAndSetParams, Directive, FinishReason, JsonSchema, MessageRole, ModelSettings, ProviderSettings, ProviderToolSpec, RunRecord, ToolErrorCategory, ToolFailureInit,
  UpdateRecordParams,
} from './index.js';
import type { TextTurnOptions, TurnOptions } from './testing/index.js';

// Compile-time check: every type that appears in a public signature can be named by consumers.
describe('public types', () => {
  it('lets provider authors and consumers name the parts of public signatures', () => {
    const parameters: JsonSchema = { type: 'object' };
    const spec: ProviderToolSpec = { name: 'echo', description: 'Echo text', parameters, strict: true };
    const role: MessageRole = 'assistant';
    const finishReason: FinishReason = 'stop';
    const directive: Directive = { type: 'status', data: { text: 'working' } };
    const category: ToolErrorCategory = 'timeout';
    const turnOptions: TurnOptions = { delayMs: 1 };
    const textTurnOptions: TextTurnOptions = { chunkSize: 2 };
    const failureInit: ToolFailureInit = { code: 'nope', message: 'no' };
    const casParams: CompareAndSetParams<number> = { collection: 'c', key: 'k', expectedVersion: undefined, value: 1 };
    const updateParams: Omit<UpdateRecordParams<number>, 'store'> = { collection: 'c', key: 'k', update: current => (current ?? 0) + 1 };
    const modelSettings: ModelSettings = { thinking: { budgetTokens: 2048 }, effort: 'high', showThinking: false };
    const providerSettings: ProviderSettings = { temperature: 0.5, stop: ['END'] };
    const recordSettings: RunRecord['settings'] = modelSettings;
    expect({ spec, role, finishReason, directive, category, turnOptions, textTurnOptions, failureInit, casParams, updateParams, providerSettings, recordSettings }).toMatchObject({ spec: { name: 'echo' }, role: 'assistant' });
  });
});
