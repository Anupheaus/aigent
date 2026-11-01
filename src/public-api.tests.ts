import { describe, expect, it } from 'vitest';
import * as api from './index.js';
import * as contract from './testing/contract/index.js';
import * as testing from './testing/index.js';
import * as fsPack from './tools/packs/fs/index.js';
import * as dataPack from './tools/packs/data/index.js';
import * as metaPack from './tools/packs/meta/index.js';
import * as webPack from './tools/packs/web/index.js';
import * as codePack from './tools/packs/code/index.js';
import * as shellPack from './tools/packs/shell/index.js';
import * as gitPack from './tools/packs/git/index.js';
import * as dbPack from './tools/packs/db/index.js';
import * as knowledgePack from './tools/packs/knowledge/index.js';
import * as mcp from './mcp/index.js';
import * as indexPack from './tools/packs/index/index.js';
import * as mongoStores from './stores/mongo/index.js';

describe('public API', () => {
  it('exports the documented surface and nothing placeholder', () => {
    expect(Object.keys(api).sort()).toEqual([
      'BUILTIN_GUARDRAILS', 'CHECKPOINT_SCHEMA_VERSION', 'EFFECTS_COLLECTION', 'GUARDRAIL_STAGES', 'QUESTION_TYPES', 'ROOT_BRANCH_ID', 'RUN_RECORD_SCHEMA_VERSION', 'anthropic', 'anthropicPlugin', 'createAigent', 'createAigentError', 'createConversationStore', 'createEmptyConversation', 'createFileStore', 'createInMemoryStore', 'createScheduler', 'createWriteQueue', 'deepseek', 'deepseekPlugin', 'defineBatchTool', 'defineGuardrail', 'definePlugin', 'defineTool',
      'isAigentError', 'ollama', 'ollamaPlugin', 'openAiCompatible', 'openAiCompatiblePlugin', 'openai', 'openaiPlugin', 'pluginTools', 'reduceConversation', 'toolFailure', 'updateRecord',
    ]);
  });

  it('exports test helpers separately', () => {
    expect(Object.keys(testing).sort()).toEqual(['createBrokenCompressor', 'createFakeProvider', 'createMemoryTransportPair', 'fakeCompressor', 'textTurn', 'toolTurn']);
  });

  it('exports the filesystem pack from its own entry', () => {
    expect(Object.keys(fsPack).sort()).toEqual(['DEFAULT_SEARCH_IGNORES', 'createFsPolicy', 'createMemoryFsAccess', 'createNodeFsAccess', 'fsError', 'fsErrorCode', 'fsTools', 'matchGlob', 'parseIgnoreFile']);
  });

  it('exports the data and meta packs from their own entries', () => {
    expect(Object.keys(dataPack).sort()).toEqual(['MAX_REGEX_INPUT_CHARS', 'REGEX_CHUNK_CHARS', 'REGEX_TIME_BUDGET_MS', 'dataTools']);
    expect(Object.keys(metaPack).sort()).toEqual(['DEFAULT_RETURN_BUDGET_TOKENS', 'MAX_DELEGATION_DEPTH', 'metaTools']);
  });

  it('exports the web pack from its own entry', () => {
    expect(Object.keys(webPack).sort()).toEqual(['classifyAddress', 'createFetchHttpAccess', 'createHttpPolicy', 'createNodeHttpAccess', 'webTools']);
  });

  it('exports the code-intelligence pack from its own entry', () => {
    expect(Object.keys(codePack).sort()).toEqual(['codeTools']);
  });

  it('exports the shell pack from its own entry', () => {
    expect(Object.keys(shellPack).sort()).toEqual(['DEFAULT_ENV_ALLOW', 'MAX_TIMEOUT_MS', 'createNodeProcessRunner', 'createShellPolicy', 'scrubEnv', 'shellTools']);
  });

  it('exports the git pack from its own entry', () => {
    expect(Object.keys(gitPack).sort()).toEqual(['gitTools']);
  });

  it('exports the database pack from its own entry', () => {
    expect(Object.keys(dbPack).sort()).toEqual(['createDbPolicy', 'createMemoryDbAccess', 'createMongoDbAccess', 'dbTools', 'toTaggedJson', 'validateQuery']);
  });

  it('exports the knowledge pack from its own entry', () => {
    expect(Object.keys(knowledgePack).sort()).toEqual(['createChunker', 'createFileVectorIndex', 'createKnowledgeBase', 'createMemoryVectorIndex', 'createStoreVectorIndex', 'evalRetrieval', 'hashEmbedder', 'knowledgeTools', 'openAiEmbedder', 'scanSources']);
  });

  it('exports the repository index pack from its own entry', () => {
    expect(Object.keys(indexPack).sort()).toEqual(['FILE_TAGS', 'REPO_INDEX_COLLECTION', 'createRepoIndex', 'indexTools']);
  });

  it('exports the MCP plugin from its own entry', () => {
    expect(Object.keys(mcp).sort()).toEqual(['MCP_PROTOCOL_VERSION', 'createHttpTransport', 'createStdioTransport', 'mcpPlugin']);
  });

  it('exports the MongoDB store from its own entry', () => {
    expect(Object.keys(mongoStores).sort()).toEqual(['connectMongoStore', 'createMongoStore']);
  });

  it('exports the vitest-based provider contract suite from its own entry', () => {
    expect(Object.keys(contract).sort()).toEqual(['chunkBytes', 'describeProviderContract', 'describeStoreContract']);
  });
});
