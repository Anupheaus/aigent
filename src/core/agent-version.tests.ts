import { describe, expect, it } from 'vitest';
import { computeAgentVersion } from './agent-version.js';
import type { AgentVersionInput, AgentVersionTool } from './agent-version.js';
import { canonicalJson } from './canonical-json.js';

const HEX_SHA_256 = /^[0-9a-f]{64}$/;

const searchTool: AgentVersionTool = {
  name: 'search', description: 'Searches', jsonSchema: { type: 'object', properties: { q: { type: 'string' } } }, strict: true,
  deterministic: false, cache: false, hasSideEffects: false, timeoutMs: 30_000,
};
const writeTool: AgentVersionTool = {
  name: 'write', description: 'Writes', jsonSchema: { type: 'object' }, strict: true,
  deterministic: true, cache: true, cacheTtlMs: 1_000, hasSideEffects: true, timeoutMs: 10_000, maxResultTokens: 500,
};

const BASE: AgentVersionInput = {
  libraryVersion: '0.0.1',
  model: 'anthropic:claude-test',
  persona: 'Calm',
  skillset: 'Writes',
  context: 'A repo',
  modelSettings: { temperature: 0.2, providerOptions: { a: 1, b: 2 } },
  limits: { maxTurns: 5 },
  version: 'v1',
  tools: [searchTool, writeTool],
};

describe('canonicalJson', () => {
  it('sorts keys recursively, keeps array order and drops undefined object values', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined, x: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"x":2,"z":1}]},"b":1}');
  });
});

describe('computeAgentVersion', () => {
  it('returns a lowercase hex sha-256', () => {
    expect(computeAgentVersion(BASE)).toMatch(HEX_SHA_256);
  });

  it('is stable across key order, tool order and undefined fields', () => {
    const reordered: AgentVersionInput = {
      tools: [{ ...writeTool }, { ...searchTool, cacheTtlMs: undefined }],
      version: 'v1',
      limits: { maxTurns: 5 },
      modelSettings: { providerOptions: { b: 2, a: 1 }, temperature: 0.2 },
      context: 'A repo',
      skillset: 'Writes',
      persona: 'Calm',
      model: 'anthropic:claude-test',
      libraryVersion: '0.0.1',
    };
    expect(computeAgentVersion(reordered)).toBe(computeAgentVersion(BASE));
  });

  it('ignores name and instanceId even when present at runtime', () => {
    const withIdentity = { ...BASE, name: 'other', instanceId: 'instance-9' } as AgentVersionInput;
    expect(computeAgentVersion(withIdentity)).toBe(computeAgentVersion(BASE));
  });

  it('ignores tool fields that do not change behaviour, such as the run function', () => {
    const withRun = { ...searchTool, run: async () => 1 } as AgentVersionTool;
    expect(computeAgentVersion({ ...BASE, tools: [withRun, writeTool] })).toBe(computeAgentVersion(BASE));
  });

  const changes: [string, AgentVersionInput][] = [
    ['libraryVersion', { ...BASE, libraryVersion: '0.0.2' }],
    ['model', { ...BASE, model: 'anthropic:claude-other' }],
    ['persona', { ...BASE, persona: 'Brisk' }],
    ['skillset', { ...BASE, skillset: undefined }],
    ['context', { ...BASE, context: 'Another repo' }],
    ['modelSettings', { ...BASE, modelSettings: { temperature: 0.3, providerOptions: { a: 1, b: 2 } } }],
    ['modelSettings.providerOptions', { ...BASE, modelSettings: { temperature: 0.2, providerOptions: { a: 1, b: 3 } } }],
    ['limits', { ...BASE, limits: { maxTurns: 6 } }],
    ['version', { ...BASE, version: 'v2' }],
    ['a tool added', { ...BASE, tools: [searchTool] }],
    ['tool name', { ...BASE, tools: [{ ...searchTool, name: 'find' }, writeTool] }],
    ['tool description', { ...BASE, tools: [{ ...searchTool, description: 'Finds' }, writeTool] }],
    ['tool jsonSchema', { ...BASE, tools: [{ ...searchTool, jsonSchema: { type: 'object' } }, writeTool] }],
    ['tool strict', { ...BASE, tools: [{ ...searchTool, strict: false }, writeTool] }],
    ['tool deterministic', { ...BASE, tools: [{ ...searchTool, deterministic: true }, writeTool] }],
    ['tool cache', { ...BASE, tools: [{ ...searchTool, cache: true }, writeTool] }],
    ['tool cacheTtlMs', { ...BASE, tools: [searchTool, { ...writeTool, cacheTtlMs: 2_000 }] }],
    ['tool hasSideEffects', { ...BASE, tools: [{ ...searchTool, hasSideEffects: true }, writeTool] }],
    ['tool timeoutMs', { ...BASE, tools: [{ ...searchTool, timeoutMs: 1 }, writeTool] }],
    ['tool maxResultTokens', { ...BASE, tools: [searchTool, { ...writeTool, maxResultTokens: 501 }] }],
    ['fallbackModels', { ...BASE, fallbackModels: ['openai:gpt-test'] }],
    ['resilience', { ...BASE, resilience: { maxRetries: 0 } }],
  ];

  it.each(changes)('changes when %s changes', (_field, changed) => {
    expect(computeAgentVersion(changed)).not.toBe(computeAgentVersion(BASE));
  });
});
