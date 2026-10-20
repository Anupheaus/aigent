import { describe, expect, it } from 'vitest';
import * as api from './index.js';
import * as testing from './testing/index.js';

describe('public API', () => {
  it('exports the documented surface and nothing placeholder', () => {
    expect(Object.keys(api).sort()).toEqual([
      'createAigent', 'createAigentError', 'createInMemoryStore', 'createWriteQueue', 'defineBatchTool', 'defineTool', 'isAigentError', 'toolFailure',
    ]);
  });

  it('exports test helpers separately', () => {
    expect(Object.keys(testing).sort()).toEqual(['createFakeProvider', 'textTurn', 'toolTurn']);
  });
});
