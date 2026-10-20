import { openAiCompatible } from './openai-compatible.js';
import type { Provider } from './provider-types.js';

/** Options shared by the OpenAI-compatible presets. */
export interface PresetOptions {
  /** API key for the service; optional for local servers such as Ollama. */
  apiKey?: string;
  /** Overrides the preset's API root (e.g. a proxy or self-hosted gateway). */
  baseUrl?: string;
  /** HTTP implementation; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** Ollama's OpenAI-compatible endpoint on its default local port. */
const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

/** DeepSeek's hosted API (`deepseek:<model>`). */
export function deepseek(options: PresetOptions = {}): Provider {
  const { baseUrl = DEEPSEEK_BASE_URL, ...rest } = options;
  return openAiCompatible({ id: 'deepseek', baseUrl, ...rest });
}

/** OpenAI's hosted API (`openai:<model>`). */
export function openai(options: PresetOptions = {}): Provider {
  const { baseUrl = OPENAI_BASE_URL, ...rest } = options;
  return openAiCompatible({ id: 'openai', baseUrl, ...rest });
}

/** A local Ollama server (`ollama:<model>`); no API key needed. */
export function ollama(options: PresetOptions = {}): Provider {
  const { baseUrl = OLLAMA_BASE_URL, ...rest } = options;
  return openAiCompatible({ id: 'ollama', baseUrl, ...rest });
}
