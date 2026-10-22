import { LIBRARY_VERSION } from '../core/library-version.js';
import { definePlugin } from '../plugins/define-plugin.js';
import type { Plugin } from '../plugins/plugin-types.js';
import { anthropic } from './anthropic.js';
import type { AnthropicOptions } from './anthropic.js';
import { openAiCompatible } from './openai-compatible.js';
import type { OpenAiCompatibleOptions } from './openai-compatible.js';
import type { ReasoningModelMatcher } from './openai-settings.js';
import type { Provider } from './provider-types.js';

/** Options shared by the OpenAI-compatible presets. */
export interface PresetOptions {
  /** API key for the service; optional for local servers such as Ollama. */
  apiKey?: string;
  /** Overrides the preset's API root (e.g. a proxy or self-hosted gateway). */
  baseUrl?: string;
  /** HTTP implementation; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Overrides the preset's reasoning-model test (see `OpenAiCompatibleOptions.isReasoningModel`). */
  isReasoningModel?: ReasoningModelMatcher;
}

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** Ollama's OpenAI-compatible endpoint on its default local port. */
const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
/** OpenAI's reasoning families (o1, o3, o4-mini, gpt-5...), which reject sampling settings and take `reasoning_effort`. */
const OPENAI_REASONING_MODEL = /^(o[0-9]|gpt-5)/;

function isOpenAiReasoningModel(model: string): boolean {
  return OPENAI_REASONING_MODEL.test(model);
}

/** DeepSeek's hosted API (`deepseek:<model>`). */
export function deepseek(options: PresetOptions = {}): Provider {
  const { baseUrl = DEEPSEEK_BASE_URL, ...rest } = options;
  return openAiCompatible({ id: 'deepseek', baseUrl, ...rest });
}

/** OpenAI's hosted API (`openai:<model>`). */
export function openai(options: PresetOptions = {}): Provider {
  const { baseUrl = OPENAI_BASE_URL, isReasoningModel = isOpenAiReasoningModel, ...rest } = options;
  // Current OpenAI models accept max_completion_tokens, and reasoning models reject max_tokens.
  return openAiCompatible({ id: 'openai', baseUrl, tokenLimitField: 'max_completion_tokens', isReasoningModel, ...rest });
}

/** A local Ollama server (`ollama:<model>`); no API key needed. */
export function ollama(options: PresetOptions = {}): Provider {
  const { baseUrl = OLLAMA_BASE_URL, ...rest } = options;
  return openAiCompatible({ id: 'ollama', baseUrl, ...rest });
}

// ─── The same providers as plugins ───

/** A plugin offering exactly one provider, named after its id and versioned with this library. */
function providerPlugin(provider: Provider): Plugin {
  return definePlugin({ name: provider.id, version: LIBRARY_VERSION, providers: [provider] });
}

/** `anthropic(options)` as a plugin: `createAigent({ plugins: [anthropicPlugin({ apiKey })] })`. */
export function anthropicPlugin(options: AnthropicOptions): Plugin {
  return providerPlugin(anthropic(options));
}

/** `openAiCompatible(options)` as a plugin named after its `id` (which must then be kebab-case). */
export function openAiCompatiblePlugin(options: OpenAiCompatibleOptions): Plugin {
  return providerPlugin(openAiCompatible(options));
}

/** `deepseek(options)` as a plugin. */
export function deepseekPlugin(options: PresetOptions = {}): Plugin {
  return providerPlugin(deepseek(options));
}

/** `openai(options)` as a plugin. */
export function openaiPlugin(options: PresetOptions = {}): Plugin {
  return providerPlugin(openai(options));
}

/** `ollama(options)` as a plugin. */
export function ollamaPlugin(options: PresetOptions = {}): Plugin {
  return providerPlugin(ollama(options));
}
