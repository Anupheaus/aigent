import { describe, expect, it } from 'vitest';
import type { Directive, FinishReason, JsonSchema, MessageRole, ProviderToolSpec, ToolErrorCategory } from './index.js';
import type { TextTurnOptions, TurnOptions } from './testing/index.js';

// Compile-time check: every type that appears in a public signature can be named by consumers.
describe('public types', () => {
  it('lets provider authors and consumers name the parts of public signatures', () => {
    const parameters: JsonSchema = { type: 'object' };
    const spec: ProviderToolSpec = { name: 'echo', description: 'Echo text', parameters };
    const role: MessageRole = 'assistant';
    const finishReason: FinishReason = 'stop';
    const directive: Directive = { type: 'status', data: { text: 'working' } };
    const category: ToolErrorCategory = 'timeout';
    const turnOptions: TurnOptions = { delayMs: 1 };
    const textTurnOptions: TextTurnOptions = { chunkSize: 2 };
    expect({ spec, role, finishReason, directive, category, turnOptions, textTurnOptions }).toMatchObject({ spec: { name: 'echo' }, role: 'assistant' });
  });
});
