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
  modelSettings: { temperature: 0.2, providerOptions: { p: { a: 1, b: 2 } } },
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

  it('treats todo as on when absent, so earlier versions keep their hash', () => {
    expect(computeAgentVersion({ ...BASE, todo: true })).toBe(computeAgentVersion(BASE));
  });

  it('changes with the resolved enableFeedback flag, and treats it as off when absent', () => {
    expect(computeAgentVersion({ ...BASE, enableFeedback: true })).not.toBe(computeAgentVersion({ ...BASE, enableFeedback: false }));
    expect(computeAgentVersion({ ...BASE, enableFeedback: false })).toBe(computeAgentVersion(BASE));
  });

  it('is stable across key order, tool order and undefined fields', () => {
    const reordered: AgentVersionInput = {
      tools: [{ ...writeTool }, { ...searchTool, cacheTtlMs: undefined }],
      version: 'v1',
      limits: { maxTurns: 5 },
      modelSettings: { providerOptions: { p: { b: 2, a: 1 } }, temperature: 0.2 },
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
    ['modelSettings', { ...BASE, modelSettings: { temperature: 0.3, providerOptions: { p: { a: 1, b: 2 } } } }],
    ['modelSettings.providerOptions', { ...BASE, modelSettings: { temperature: 0.2, providerOptions: { p: { a: 1, b: 3 } } } }],
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
    ['tool version', { ...BASE, tools: [{ ...searchTool, version: '2' }, writeTool] }],
    ['tool contentKind', { ...BASE, tools: [{ ...searchTool, contentKind: 'search-hits' }, writeTool] }],
    ['tool fidelity', { ...BASE, tools: [{ ...searchTool, contentKind: 'search-hits', fidelity: 'lossy-ok' }, writeTool] }],
    ['shapers', { ...BASE, shapers: 'off' }],
    ['todo turned off', { ...BASE, todo: false }],
    ['fallbacks', { ...BASE, fallbacks: [{ model: 'openai:gpt-test' }] }],
    ['a fallback model', { ...BASE, fallbacks: [{ model: 'openai:gpt-other' }] }],
    ['resilience', { ...BASE, resilience: { maxRetries: 0 } }],
  ];

  it('changes when only the effective settings of a fallback model change', () => {
    const withFallback: AgentVersionInput = { ...BASE, fallbacks: [{ model: 'openai:gpt-test', modelSettings: { temperature: 0.2 } }] };
    const changed: AgentVersionInput = { ...BASE, fallbacks: [{ model: 'openai:gpt-test', modelSettings: { temperature: 0.4 } }] };
    expect(computeAgentVersion(changed)).not.toBe(computeAgentVersion(withFallback));
  });

  const equivalents: [string, AgentVersionInput, AgentVersionInput][] = [
    ['resilience {} and the defaults', { ...BASE, resilience: {} }, { ...BASE, resilience: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 20_000, jitter: 0.2, fallbackOnNonRetryable: false } }],
    ['resilience absent and {}', BASE, { ...BASE, resilience: {} }],
    ['resilience absent and an undefined field', BASE, { ...BASE, resilience: { maxRetries: undefined } }],
    ['no fallbacks and []', BASE, { ...BASE, fallbacks: [] }],
    ['limits absent and the default limits', { ...BASE, limits: undefined }, { ...BASE, limits: { maxTurns: 25, maxToolCalls: 100 } }],
    ['limits absent and {}', { ...BASE, limits: undefined }, { ...BASE, limits: {} }],
    ['modelSettings absent and {}', { ...BASE, modelSettings: undefined }, { ...BASE, modelSettings: {} }],
    ['no providerOptions and empty ones', { ...BASE, modelSettings: { temperature: 0.2 } }, { ...BASE, modelSettings: { temperature: 0.2, providerOptions: { p: {} }, stop: [] } }],
    ['an empty fallback settings object and none', { ...BASE, fallbacks: [{ model: 'o:m' }] }, { ...BASE, fallbacks: [{ model: 'o:m', modelSettings: {} }] }],
    ['an empty persona and none', { ...BASE, persona: undefined }, { ...BASE, persona: '' }],
  ];

  it.each(equivalents)('is unchanged by noise: %s', (_case, left, right) => {
    expect(computeAgentVersion(left)).toBe(computeAgentVersion(right));
  });

  it.each(changes)('changes when %s changes', (_field, changed) => {
    expect(computeAgentVersion(changed)).not.toBe(computeAgentVersion(BASE));
  });

  it('changes when memory is turned on or its options change, and is unchanged without it', () => {
    const memory = { scope: 'agent' as const, maxEntries: 200, maxPerCall: 3, halfLifeDays: 30, minConfidence: 0.2, recallLimit: 6 };
    expect(computeAgentVersion({ ...BASE, memory: undefined })).toBe(computeAgentVersion(BASE));
    expect(computeAgentVersion({ ...BASE, memory })).not.toBe(computeAgentVersion(BASE));
    expect(computeAgentVersion({ ...BASE, memory: { ...memory, maxPerCall: 2 } })).not.toBe(computeAgentVersion({ ...BASE, memory }));
  });
});
