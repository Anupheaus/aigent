import { describe, expect, it } from 'vitest';
import * as api from './index.js';
import * as contract from './testing/contract/index.js';
import * as testing from './testing/index.js';

describe('public API', () => {
  it('exports the documented surface and nothing placeholder', () => {
    expect(Object.keys(api).sort()).toEqual([
      'BUILTIN_GUARDRAILS', 'CHECKPOINT_SCHEMA_VERSION', 'EFFECTS_COLLECTION', 'GUARDRAIL_STAGES', 'QUESTION_TYPES', 'ROOT_BRANCH_ID', 'RUN_RECORD_SCHEMA_VERSION', 'anthropic', 'createAigent', 'createAigentError', 'createConversationStore', 'createEmptyConversation', 'createInMemoryStore', 'createScheduler', 'createWriteQueue', 'deepseek', 'defineBatchTool', 'defineGuardrail', 'defineTool',
      'isAigentError', 'ollama', 'openAiCompatible', 'openai', 'reduceConversation', 'toolFailure', 'updateRecord',
    ]);
  });

  it('exports test helpers separately', () => {
    expect(Object.keys(testing).sort()).toEqual(['createBrokenCompressor', 'createFakeProvider', 'fakeCompressor', 'textTurn', 'toolTurn']);
  });

  it('exports the vitest-based provider contract suite from its own entry', () => {
    expect(Object.keys(contract).sort()).toEqual(['chunkBytes', 'describeProviderContract']);
  });
});
